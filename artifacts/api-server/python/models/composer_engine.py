import os
import copy
import math
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from pathlib import Path
from miditok import REMI, Octuple, TSD, TokSequence
from symusic import Score, Track, Note, Tempo, TimeSignature
import tempfile
import subprocess
import traceback

# ─── SHARED UTILITIES ────────────────────────────────────────────────────────

# Soundfont for the optional server-side WAV render. The default only exists on
# Linux; set SOUNDFONT_PATH (e.g. in .env) to a local .sf2 to enable rendering
# elsewhere. When the file is missing, rendering is skipped and the frontend
# falls back to its in-browser piano player.
SOUNDFONT_PATH = os.environ.get("SOUNDFONT_PATH", "/usr/share/sounds/sf2/FluidR3_GM.sf2")

# FluidSynth binary. On Linux it is usually on PATH; on Windows point
# FLUIDSYNTH_PATH at the .exe (e.g. the copy under api-server/tools/).
FLUIDSYNTH_BIN = os.environ.get("FLUIDSYNTH_PATH", "fluidsynth")

def _rescale_score_inplace(score, dst_tpq):
    # Adjusts the Ticks Per Quarter (TPQ) resolution of a MIDI score.
    # ML models are trained on specific temporal grids (usually 480 TPQ). 
    # If the input MIDI uses a different grid (e.g., 96 TPQ), we mathematically scale it.
    if score.tpq == dst_tpq: return score
    scale = dst_tpq / score.tpq
    for tr in score.tracks:
        for n in tr.notes:
            # Scale the start time and duration by the resolution ratio
            n.time = int(round(n.time * scale))
            n.duration = max(1, int(round(n.duration * scale)))
    score.tpq = dst_tpq
    return score


def _beats_per_bar(score):
    # Bar length in quarter notes, taken from the first time signature (4/4 default).
    if score.time_signatures:
        ts = score.time_signatures[0]
        return ts.numerator * 4.0 / ts.denominator
    return 4.0


def _score_from_live_notes(notes_data, bpm):
    # Builds a symusic Score from browser note dicts (the live-jam payload).
    raw_score = Score(480)
    raw_score.tempos.append(Tempo(time=0, qpm=bpm))
    raw_score.time_signatures.append(TimeSignature(time=0, numerator=4, denominator=4))

    track = Track(program=0, is_drum=False, name="LiveJam")
    for nd in notes_data:
        track.notes.append(Note(
            time=int(nd['time']),
            duration=int(nd['duration']),
            pitch=int(nd['pitch']),
            velocity=int(nd['velocity'])
        ))
    track.notes.sort(key=lambda n: getattr(n, 'time', 0))
    raw_score.tracks.append(track)

    # Symusic requires file I/O for a clean re-instantiation
    fd, path = tempfile.mkstemp(suffix=".mid")
    os.close(fd)
    raw_score.dump_midi(path)
    score = Score(path)
    os.remove(path)
    return score


def _live_notes_response(cont_score):
    # Formats a decoded continuation as the JSON note array the frontend expects,
    # normalized so the first note starts at time 0.
    raw_notes = [n for tr in cont_score.tracks for n in tr.notes]
    raw_notes.sort(key=lambda n: getattr(n, 'time', 0))
    if not raw_notes:
        return []
    min_time = min(getattr(n, 'time', 0) for n in raw_notes)
    return [{
        "pitch": getattr(n, 'pitch', 60),
        "time": getattr(n, 'time', 0) - min_time,
        "duration": getattr(n, 'duration', 120),
        "velocity": getattr(n, 'velocity', 80)
    } for n in raw_notes]

# ─── 1. REMI MODEL (ComposerGPT, base + <RESP> jam fine-tunes) ───────────────
# Self-contained port of GPT_Remi_Generation_ipynb.ipynb (cells 5-9); replaces
# the old JamModel wrapper from jam_inference.py. Handles BOTH checkpoint
# generations:
#   - base continuation model: vocab == len(tokenizer)      (e.g. BIG_REMI.pt)
#   - jam fine-tunes:          vocab == len(tokenizer) + 1  (classical/movies),
#     trained with a <RESP> separator between riff and response, every response
#     ending with EOS.

class AmadeusComposerREMI:
    PROMPT_BARS = 8   # prompt trimmed to its last N bars, cut on a bar line
    CHUNK_BARS = 4    # bars requested per generation round in extend_midi

    def __init__(self, checkpoint_path, tokenizer_path):
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.tokenizer = REMI(params=Path(tokenizer_path))
        tok_len = len(self.tokenizer)

        try:
            ckpt = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
        except Exception:
            ckpt = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
        sd = ckpt.get("model", ckpt)
        sd = {k[7:] if k.startswith("module.") else k: v for k, v in sd.items()}

        # Architecture from the WEIGHT SHAPES, never from cfg (cfg has drifted
        # between training runs in this project).
        vocab_size, d_model = (int(x) for x in sd["tok_emb.weight"].shape)
        max_seq_len = int(sd["pos_emb.weight"].shape[0])
        n_layers = 1 + max(int(k.split(".")[1]) for k in sd if k.startswith("blocks."))

        # <RESP> auto-detect: the jam fine-tunes carry one extra embedding row
        # for the riff/response separator, which has no tokenizer entry.
        if vocab_size == tok_len + 1:
            self.resp_id = tok_len
        elif vocab_size == tok_len:
            self.resp_id = None
        else:
            raise ValueError(
                f"Checkpoint vocab {vocab_size} does not match tokenizer "
                f"({tok_len} or {tok_len + 1} expected) — mismatched pair")

        cfg = ckpt.get("config") or {}
        # Positions past the trained window never received gradients: the model
        # was built at max_seq_len=1024 but trained on 511-token windows.
        self.max_ctx = min(int(cfg.get("seq_len") or max_seq_len), max_seq_len)

        self.model = ComposerGPT(
            vocab_size=vocab_size, d_model=d_model, n_layers=n_layers,
            n_heads=int(cfg.get("n_heads", 8)),
            max_seq_len=max_seq_len, dropout=0.0,
        ).to(self.device)
        self.model.load_state_dict(sd, strict=True)
        self.model.eval()
        self.vocab_size = vocab_size

        base = self.tokenizer.vocab if isinstance(self.tokenizer.vocab, dict) else \
               {t: i for i, t in enumerate(self.tokenizer.vocab)}
        self.is_bpe = tok_len > len(base)
        self.bars, self.has_pitch = self._build_tables(base)

        # Ban structural specials, and never sample the separator itself.
        self.banned = []
        for name in ("PAD_None", "BOS_None", "MASK_None"):
            try: self.banned.append(self.tokenizer[name])
            except Exception: pass
        if self.resp_id is not None:
            self.banned.append(self.resp_id)
        try:
            self.eos_id = self.tokenizer["EOS_None"]
        except Exception:
            self.eos_id = None

        mode = "jam fine-tune (<RESP>)" if self.resp_id is not None else "base continuation"
        print(f"[REMI] loaded {mode}: {n_layers} layers, d_model {d_model}, "
              f"vocab {vocab_size}, context {self.max_ctx} tokens, bpe={self.is_bpe}")

    def _build_tables(self, base_vocab):
        """Per-id Bar-token counts and Pitch presence. Under BPE one id can
        expand to several base tokens, so both need the expansion — built once
        at load. The <RESP> row (if any) has no token and stays 0/0."""
        bar_base = {i for t, i in base_vocab.items() if t.startswith("Bar")}
        pitch_base = {i for t, i in base_vocab.items() if t.startswith("Pitch")}
        bars = [0] * self.vocab_size
        pitch = [0] * self.vocab_size
        for i in range(len(self.tokenizer)):
            if not self.is_bpe:
                bars[i] = 1 if i in bar_base else 0
                pitch[i] = 1 if i in pitch_base else 0
                continue
            try:
                s = TokSequence(ids=[i], are_ids_encoded=True)
                self.tokenizer.decode_token_ids(s)
                toks = [t for t in (s.tokens or []) if isinstance(t, str)]
                bars[i] = sum(1 for t in toks if t.startswith("Bar"))
                pitch[i] = int(any(t.startswith("Pitch") for t in toks))
            except Exception:
                pass
        return bars, pitch

    # -------------------------------------------------- tokens

    @staticmethod
    def _densest_track_idx(score):
        """The dataset was tokenized single-track with DROP_DRUMS=True, so the
        model continues one pitched instrument — the busiest one."""
        cands = [(len(t.notes), i) for i, t in enumerate(score.tracks)
                 if not t.is_drum and len(t.notes) > 0]
        if not cands:
            raise ValueError("no usable (non-drum, non-empty) tracks")
        return max(cands)[1]

    def _encode_track(self, score, idx):
        single = copy.deepcopy(score)
        single.tracks = [single.tracks[idx]]
        res = self.tokenizer.encode(single)
        seqs = res if isinstance(res, list) else [res]
        best = max(seqs, key=lambda s: len(getattr(s, "ids", []) or []))
        return [int(i) for i in (best.ids or [])]

    def _decode(self, ids):
        ids = [int(i) for i in ids]
        if self.resp_id is not None:
            ids = [i for i in ids if i != self.resp_id]  # <RESP> has no token
        return self.tokenizer.decode([TokSequence(ids=ids, are_ids_encoded=self.is_bpe)])

    # -------------------------------------------------- bar utilities

    def _count_bars(self, ids):
        return sum(self.bars[t] for t in ids)

    def _last_n_bars(self, ids, n):
        """Suffix holding the last n complete bars, starting on a bar line.
        BARS[t] is a COUNT, not a flag — under BPE one id can hold several
        Bar tokens, so accumulate rather than index bar positions."""
        ids = list(ids)
        total = self._count_bars(ids)
        if total <= n:
            return ids
        bars = 0
        for i, t in enumerate(ids):
            bars += self.bars[t]
            if bars > total - n:
                return ids[i:]
        return ids

    def _fit_context(self, ids, reserve=0):
        """Cut to max_ctx (minus `reserve` slots), preferring a bar line."""
        limit = self.max_ctx - reserve
        ids = list(ids)
        if len(ids) <= limit:
            return ids
        window = ids[-limit:]
        for i, t in enumerate(window):
            if self.bars[t]:
                return window[i:] if i < len(window) - 32 else window
        return window

    # -------------------------------------------------- generation

    @torch.no_grad()
    def _generate(self, prompt_ids, n_bars=2, temperature=1.0, top_p=0.9,
                  max_new_tokens=None, min_notes=4):
        """Continue prompt_ids until n_bars Bar tokens, EOS, or the token cap.

        Bar tokens are OPENERS: the k-th one starts response-bar k, so n complete
        bars means stopping just before opener n+1. info["stop"] is "bars"/"eos"
        for a bar-aligned finish, "max_tokens" if the cap cut it mid-bar."""
        temperature = temperature if temperature else 1.0
        top_p = top_p if (top_p and 0 < top_p < 1.0) else 0.9
        if max_new_tokens is None:
            max_new_tokens = max(256, 160 * n_bars)

        ids = list(prompt_ids)[-self.max_ctx:]
        out, bars, notes, stop = [], 0, 0, "max_tokens"
        for _ in range(max_new_tokens):
            ctx = torch.tensor([ids[-self.max_ctx:]], dtype=torch.long, device=self.device)
            logits, _ = self.model(ctx)
            lg = logits[0, -1].float() / max(temperature, 1e-5)
            for b in self.banned:
                lg[b] = float("-inf")
            probs = torch.softmax(lg, dim=-1)
            sp, si = torch.sort(probs, descending=True)
            keep = int((torch.cumsum(sp, -1) < top_p).sum().item()) + 1
            sp, si = sp[:keep], si[:keep]
            nxt = int(si[torch.multinomial(sp / sp.sum(), 1)])

            # The jam fine-tune ends every response with EOS; past it the model
            # is off-distribution, so honouring EOS is what makes n_bars mean
            # anything. The base model almost never emits it mid-continuation.
            if self.eos_id is not None and nxt == self.eos_id:
                stop = "eos"
                break

            b = self.bars[nxt]
            if b and bars + b > n_bars and notes >= min_notes:
                stop = "bars"
                break  # this id opens bar n_bars+1 — drop it
            bars += b
            if self.has_pitch[nxt]:
                notes += 1
            out.append(nxt)
            ids.append(nxt)
        return out, {"bars": bars, "stop": stop, "n_tokens": len(out), "notes": notes}

    # -------------------------------------------------- public API

    def extend_midi(self, input_midi_path, output_midi_path, num_generate=256, temperature=0.8, top_k=0, top_p=1.0):
        # top_k is accepted for API compatibility but unused: the sampler is
        # temperature + nucleus (top-p) only, matching how the model was tuned.
        template = Score(str(input_midi_path))
        combined = copy.deepcopy(template)
        extension_only = copy.deepcopy(template)
        for tr in extension_only.tracks:
            tr.notes.clear()

        # The job router converts a bar count to tokens as bars*32; recover it.
        n_bars = max(1, int(num_generate) // 32)
        idx = self._densest_track_idx(template)
        ids = self._encode_track(template, idx)
        if not ids:
            raise ValueError("tokenizer produced no tokens from the input MIDI")
        prompt = self._last_n_bars(ids, self.PROMPT_BARS)
        print(f"[REMI] extending track {idx} for {n_bars} bars "
              f"(prompt: {len(prompt)} tokens, {self._count_bars(prompt)} bars)")

        # Chunked rounds with stall detection: each round continues the rolling
        # history. The jam fine-tunes answer a few bars per <RESP> cue, so long
        # extensions are built from several responses.
        generated, done, stalls = [], 0, 0
        max_rounds = 4 * (n_bars // self.CHUNK_BARS + 2)
        for _ in range(max_rounds):
            if done >= n_bars:
                break
            want = min(self.CHUNK_BARS, n_bars - done)
            hist = self._fit_context(prompt + generated,
                                     reserve=1 if self.resp_id is not None else 0)
            if self.resp_id is not None:
                hist = hist + [self.resp_id]
            piece, info = self._generate(hist, n_bars=want,
                                         temperature=temperature, top_p=top_p)
            if piece:
                generated.extend(piece)
                done += max(info["bars"], 0)
            # A round that closed no bar is a stall even if it produced tokens;
            # without this the loop can eat the whole budget on structure.
            stalls = 0 if (piece and info["bars"] > 0) else stalls + 1
            if stalls >= 3:
                print("[REMI] generation stalled; stopping early")
                break
        if not generated:
            raise ValueError("model produced no continuation")
        print(f"[REMI] generated {done}/{n_bars} bars ({len(generated)} tokens)")

        # Decode the continuation ALONE and splice it onto the template at the
        # next bar line — the source file is preserved (tempo curves, CCs, other
        # tracks) rather than round-tripped through the tokenizer.
        cont_score = self._decode(generated)
        if cont_score.tpq != combined.tpq:
            try: cont_score = cont_score.resample(tpq=combined.tpq)
            except Exception: cont_score = _rescale_score_inplace(cont_score, combined.tpq)

        tpb = max(1, int(combined.tpq * _beats_per_bar(template)))
        src_end = max((n.time + n.duration for tr in template.tracks for n in tr.notes),
                      default=0)
        start_tick = ((src_end + tpb - 1) // tpb) * tpb  # next bar line
        cont_notes = [n for tr in cont_score.tracks for n in tr.notes]
        cont_notes.sort(key=lambda n: getattr(n, 'time', 0))
        for n in cont_notes:
            nn = copy.deepcopy(n)
            nn.time = nn.time + start_tick
            combined.tracks[idx].notes.append(nn)
            extension_only.tracks[idx].notes.append(copy.deepcopy(nn))
        combined.tracks[idx].notes.sort(key=lambda n: getattr(n, 'time', 0))
        extension_only.tracks[idx].notes.sort(key=lambda n: getattr(n, 'time', 0))

        # Normalize time for the extension-only output so it starts at Time=0
        min_time = min((n.time for tr in extension_only.tracks for n in tr.notes), default=0)
        for tr in extension_only.tracks:
            for n in tr.notes: n.time -= min_time

        # Path Setup & Export
        base_path_str = str(output_midi_path).replace(".mid", "")
        full_path = f"{base_path_str}_full.mid"
        ext_path = f"{base_path_str}_extension.mid"
        wav_path = f"{base_path_str}.wav"

        combined.dump_midi(full_path)
        extension_only.dump_midi(ext_path)
        combined.dump_midi(str(output_midi_path))

        soundfont = SOUNDFONT_PATH
        if os.path.exists(soundfont):
            try:
                subprocess.run([FLUIDSYNTH_BIN, "-ni", "-F", wav_path, "-r", "44100", soundfont, full_path], check=True, stdout=subprocess.DEVNULL)
            except Exception as e:
                print(f"FluidSynth error: {e}")

        return output_midi_path

    def live_extend(self, notes_data, num_generate=64, temperature=0.8, bpm=120):
        # Real-time jamming endpoint: riff in, bar-aligned answer out.
        print(f"\n--- [LIVE JAM / REMI] INCOMING REQUEST ---")
        score = _score_from_live_notes(notes_data, bpm)
        idx = self._densest_track_idx(score)
        ids = self._encode_track(score, idx)
        if not ids: return []

        n_bars = max(1, min(8, int(num_generate) // 32))
        prompt = self._fit_context(self._last_n_bars(ids, self.PROMPT_BARS),
                                   reserve=1 if self.resp_id is not None else 0)
        if self.resp_id is not None:
            prompt = prompt + [self.resp_id]  # <RESP> is what cues a response

        gen, info = self._generate(prompt, n_bars=n_bars,
                                   temperature=temperature, top_p=0.9)
        print(f"[REMI] jam response: {info}")
        if not gen: return []

        cont_score = self._decode(gen)
        if cont_score.tpq != 480:
            try:
                cont_score = cont_score.resample(tpq=480)
            except Exception:
                cont_score = _rescale_score_inplace(cont_score, 480)
        return _live_notes_response(cont_score)


# ─── 2. MULTI-TRACK MODEL (OCTUPLE — RoPE transformer, conditional heads) ────
# Ported from composertrainingOctuple.ipynb (CELL 1 - MODEL), which produced the
# deployed Compose_Octuple.pt checkpoint. One step per NOTE; the eight fields of
# each note are predicted in a fixed order, each head conditioned on the fields
# already decided for that note (ctx_proj/ctx_norm).


class _RoPE(nn.Module):
    """Rotary position embedding. Relative and extrapolating, so a model trained
    at SEQ_LEN can generate past it - which is the point of the continuation model."""

    def __init__(self, head_dim, base=10000.0, max_len=8192):
        super().__init__()
        inv = 1.0 / (base ** (torch.arange(0, head_dim, 2).float() / head_dim))
        freqs = torch.outer(torch.arange(max_len).float(), inv)
        self.register_buffer("cos", freqs.cos()[None, None], persistent=False)
        self.register_buffer("sin", freqs.sin()[None, None], persistent=False)

    def forward(self, q, k, offset=0):
        L = q.size(-2)
        cos = self.cos[..., offset:offset + L, :]
        sin = self.sin[..., offset:offset + L, :]

        def rot(x):
            x1, x2 = x[..., ::2], x[..., 1::2]
            return torch.stack((x1 * cos - x2 * sin, x1 * sin + x2 * cos), -1).flatten(-2)

        return rot(q), rot(k)


class _OctupleBlock(nn.Module):
    """Pre-norm transformer block with causal SDPA attention and RoPE."""

    def __init__(self, d_model, n_heads, dropout, rope):
        super().__init__()
        self.n_heads, self.dropout, self.rope = n_heads, dropout, rope
        self.norm1 = nn.LayerNorm(d_model)
        self.qkv = nn.Linear(d_model, 3 * d_model, bias=False)
        self.attn_out = nn.Linear(d_model, d_model, bias=False)
        self.norm2 = nn.LayerNorm(d_model)
        self.mlp = nn.Sequential(
            nn.Linear(d_model, 4 * d_model), nn.GELU(),
            nn.Linear(4 * d_model, d_model), nn.Dropout(dropout),
        )

    def forward(self, x, offset=0):
        B, L, D = x.shape
        h = self.norm1(x)
        q, k, v = self.qkv(h).chunk(3, dim=-1)
        q = q.view(B, L, self.n_heads, -1).transpose(1, 2)
        k = k.view(B, L, self.n_heads, -1).transpose(1, 2)
        v = v.view(B, L, self.n_heads, -1).transpose(1, 2)
        q, k = self.rope(q, k, offset)
        a = F.scaled_dot_product_attention(
            q, k, v, is_causal=True, dropout_p=self.dropout if self.training else 0.0)
        x = x + self.attn_out(a.transpose(1, 2).reshape(B, L, D))
        return x + self.mlp(self.norm2(x))


def _octuple_sample_from_logits(logits, temperature, top_p):
    # logits: (B, vocab). temperature <= 0 means greedy.
    if temperature <= 0:
        return logits.argmax(-1)
    probs = F.softmax(logits / temperature, dim=-1)
    if top_p is not None and top_p < 1.0:
        sp, si = probs.sort(dim=-1, descending=True)
        keep = (sp.cumsum(-1) - sp) < top_p
        sp = sp * keep
        sp = sp / sp.sum(-1, keepdim=True).clamp(min=1e-9)
        return si.gather(-1, torch.multinomial(sp, 1)).squeeze(-1)
    return torch.multinomial(probs, 1).squeeze(-1)


class ComposerOctuple(nn.Module):
    """~40M params at defaults. One step per NOTE; eight conditional heads per step."""

    def __init__(self, vocab_sizes, head_order, d_model=512, n_layers=12, n_heads=8,
                 max_seq_len=1024, dropout=0.1, field_dims=None):
        super().__init__()
        self.vocab_sizes = list(vocab_sizes)
        self.num_fields = len(vocab_sizes)
        self.head_order = list(head_order)
        assert sorted(self.head_order) == list(range(self.num_fields)), \
            "head_order must be a permutation of all field indices"
        self.max_seq_len = max_seq_len

        # Field embedding widths must match the checkpoint exactly, so they are
        # passed in from the saved weight shapes rather than recomputed.
        fd = field_dims
        self.field_dims = fd
        self.embs = nn.ModuleList(nn.Embedding(v, d) for v, d in zip(vocab_sizes, fd))
        self.in_proj = nn.Linear(sum(fd), d_model)
        self.drop = nn.Dropout(dropout)

        rope = _RoPE(d_model // n_heads, max_len=max(4 * max_seq_len, 8192))
        self.blocks = nn.ModuleList(_OctupleBlock(d_model, n_heads, dropout, rope)
                                    for _ in range(n_layers))
        self.norm_f = nn.LayerNorm(d_model)

        # Conditional heads: head f reads the hidden state plus everything already
        # decided for this note, folded in through ctx_proj.
        self.heads = nn.ModuleList(nn.Linear(d_model, v) for v in vocab_sizes)
        self.ctx_proj = nn.ModuleList(nn.Linear(d, d_model, bias=False) for d in fd)
        self.ctx_norm = nn.ModuleList(nn.LayerNorm(d_model) for _ in fd)

    def encode(self, x, offset=0):
        e = torch.cat([emb(x[..., i]) for i, emb in enumerate(self.embs)], dim=-1)
        h = self.drop(self.in_proj(e))
        for blk in self.blocks:
            h = blk(h, offset)
        return self.norm_f(h)

    def forward(self, x, targets=None, offset=0):
        """targets=None -> hidden states. Otherwise a (1, num_fields) tensor of
        per-field mean NLL (used by the health check)."""
        h = self.encode(x, offset)
        if targets is None:
            return h
        losses, ctx = [None] * self.num_fields, h
        for f in self.head_order:
            lg = self.heads[f](ctx)
            losses[f] = F.cross_entropy(lg.float().reshape(-1, lg.size(-1)),
                                        targets[..., f].reshape(-1))
            # teacher forcing *within* the step: condition on the true field value
            ctx = self.ctx_norm[f](ctx + self.ctx_proj[f](self.embs[f](targets[..., f])))
        return torch.stack(losses).unsqueeze(0)

    @torch.no_grad()
    def sample_next(self, x, temps, top_p, constraint_fn=None, offset=0):
        """Sample one complete note. constraint_fn(field, partial) returns a bool
        mask (B, vocab) of ALLOWED ids, or None. It is called just before each
        field is sampled and receives the fields already decided for this note,
        so Position can be masked against the Bar that was just drawn - which is
        why Bar and Position lead the head order."""
        ctx = self.encode(x, offset)[:, -1]
        out = torch.zeros(x.size(0), self.num_fields, dtype=torch.long, device=x.device)
        for f in self.head_order:
            lg = self.heads[f](ctx).float()
            if constraint_fn is not None:
                m = constraint_fn(f, out)
                if m is not None:
                    lg = lg.masked_fill(~m, float("-inf"))
            nxt = _octuple_sample_from_logits(lg, temps[f], top_p[f])
            out[:, f] = nxt
            ctx = self.ctx_norm[f](ctx + self.ctx_proj[f](self.embs[f](nxt)))
        return out

class AmadeusComposerOctuple:
    # Per-field sampling defaults: structural fields cold, expressive fields warm.
    # Sampling Program hot makes the arrangement flicker between instruments.
    TEMP_SCALE = {"Pitch": 1.0, "Duration": 0.9, "Velocity": 1.0, "Position": 0.8,
                  "Bar": 0.7, "Program": 0.6, "Tempo": 0.7, "TimeSig": 0.5}
    PROMPT_NOTES = 256          # notes of context taken from the end of each track
    MAX_NOTES_PER_TRACK = 1024  # hard cap; the bar target normally stops us first
    MAX_TRACKS = 8

    def __init__(self, checkpoint_path, tokenizer_path):
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

        # Setup MidiTok Octuple tokenizer parameters
        target_path = Path(tokenizer_path).parent / "Compose_Octuple.json"
        if target_path.exists():
            self.tokenizer = Octuple(params=target_path)
        else:
            self.tokenizer = Octuple(params=Path(tokenizer_path))

        ckpt = torch.load(checkpoint_path, map_location=self.device, weights_only=True)
        state = {k[7:] if k.startswith("module.") else k: v
                 for k, v in ckpt.get("model", ckpt).items()}
        cfg = ckpt.get("config", {}) or {}

        # Architecture is read from the WEIGHT SHAPES, not from cfg: config keys
        # have drifted between training runs in this project (a stale cfg once
        # caused a KeyError on 'embed_size') and cfg is advisory only.
        n_fields = len([k for k in state if k.startswith("embs.") and k.endswith(".weight")])
        if n_fields == 0:
            raise ValueError(
                "Checkpoint is not a ComposerOctuple transformer (no embs.* keys). "
                f"First keys: {sorted(state)[:8]}")
        vocab_sizes = [state[f"embs.{i}.weight"].shape[0] for i in range(n_fields)]
        field_dims = [state[f"embs.{i}.weight"].shape[1] for i in range(n_fields)]
        n_layers = max(int(k.split(".")[1]) for k in state
                       if k.startswith("blocks.") and k.split(".")[1].isdigit()) + 1
        d_model = state["in_proj.weight"].shape[0]

        tok_sizes = [len(v) for v in self.tokenizer.vocab]
        if tok_sizes != vocab_sizes:
            raise ValueError(
                "Tokenizer does not match the checkpoint: checkpoint expects "
                f"{vocab_sizes}, tokenizer provides {tok_sizes}. They must come "
                "from the same training run.")

        self.vocab_sizes = vocab_sizes
        self.num_fields = n_fields
        self.seq_len = int(cfg.get("seq_len", 1023))  # training window, in NOTES

        self.model = ComposerOctuple(
            vocab_sizes=vocab_sizes,
            head_order=cfg.get("head_order", list(range(n_fields))),
            d_model=d_model, n_layers=n_layers,
            n_heads=int(cfg.get("n_heads", 8)),
            max_seq_len=self.seq_len + 1,
            dropout=0.0, field_dims=field_dims,
        ).to(self.device)
        self.model.load_state_dict(state, strict=True)
        self.model.eval()

        # Field layout: from the training config when present, else detected from
        # the vocabulary. Column order has moved between miditok releases, so it
        # is never assumed.
        fields = cfg.get("fields") or self._detect_fields(self.tokenizer.vocab)
        self.fields = fields
        self.idx2name = {i: n for n, i in fields.items()}
        self.bar_idx = fields["Bar"]
        self.pos_idx = fields["Position"]
        self.bar0_id = self.tokenizer.vocab[self.bar_idx]["Bar_0"]
        self.max_bar = vocab_sizes[self.bar_idx] - self.bar0_id - 1

        # Ban PAD/BOS/EOS/MASK in every field. These ids exist in every vocabulary
        # and nothing stops the model drawing one; a PAD in the Program field
        # yields a row miditok cannot decode at all.
        self.allowed = []
        for f, voc in enumerate(self.tokenizer.vocab):
            m = torch.ones(1, vocab_sizes[f], dtype=torch.bool, device=self.device)
            for t in getattr(self.tokenizer, "special_tokens", []):
                if t in voc:
                    m[0, voc[t]] = False
            self.allowed.append(m)

        print(f"[Octuple] loaded: {n_layers} layers, d_model {d_model}, "
              f"context {self.seq_len} notes, Bar vocabulary reaches bar {self.max_bar}")

    @staticmethod
    def _detect_fields(vocabs):
        names = ["Pitch", "Velocity", "Duration", "Position", "Bar",
                 "Program", "Tempo", "TimeSig"]
        out = {}
        for i, voc in enumerate(vocabs):
            for n in names:
                if n not in out and any(str(t).startswith(n + "_") for t in voc):
                    out[n] = i
                    break
        return out

    def _make_constraint_fn(self, last_bar_local, last_pos):
        """Bar may hold or advance by at most 2 (a skipped bar is a rest, not an
        error); Position may not move backwards inside the same bar. Specials are
        banned in every field. Written for batch size 1."""
        def fn(f, partial):
            base = self.allowed[f]
            if f == self.bar_idx:
                m = torch.zeros_like(base)
                lo = self.bar0_id + last_bar_local
                m[0, lo:min(lo + 3, self.vocab_sizes[f])] = True
                return base & m
            if f == self.pos_idx and \
                    int(partial[0, self.bar_idx].item()) - self.bar0_id == last_bar_local:
                m = base.clone()
                m[0, :last_pos] = False
                return m if m.any() else base
            return base
        return fn

    @torch.no_grad()
    def _generate_notes(self, prompt_rows, num_notes, temperature, top_p, until_bar=None):
        """prompt_rows: (n, num_fields) int array, bars at any offset. The model
        was trained ONLY on windows re-based to start at Bar_0 (bars_rebased=true
        in the dataset manifest), so the sliding context is re-based before every
        forward pass and the shift restored on each generated note. Returns
        prompt + generated rows in the prompt's original bar frame. until_bar
        stops once a note lands at/past that bar (same frame as the prompt)."""
        temperature = temperature if temperature else 0.9
        top_p = top_p if (top_p and 0 < top_p <= 1.0) else 0.95
        temps = [temperature * self.TEMP_SCALE.get(self.idx2name.get(i, ""), 1.0)
                 for i in range(self.num_fields)]
        tps = [top_p] * self.num_fields

        gen = torch.as_tensor(np.asarray(prompt_rows), dtype=torch.long, device=self.device)
        ctx_len = self.seq_len + 1
        for step in range(num_notes):
            ctx = gen[-ctx_len:]
            shift = int(ctx[0, self.bar_idx].item()) - self.bar0_id
            if shift:
                ctx = ctx.clone()
                ctx[:, self.bar_idx] -= shift
            if int(ctx[:, self.bar_idx].max().item()) - self.bar0_id > self.max_bar:
                print("[Octuple] context spans more bars than the Bar vocabulary; stopping")
                break
            last_bar_local = int(ctx[-1, self.bar_idx].item()) - self.bar0_id
            last_pos = int(ctx[-1, self.pos_idx].item())
            nxt = self.model.sample_next(
                ctx.unsqueeze(0), temps, tps,
                constraint_fn=self._make_constraint_fn(last_bar_local, last_pos))[0].clone()
            nxt[self.bar_idx] += shift  # local -> the prompt's frame
            if int(nxt[self.bar_idx].item()) - self.bar0_id > self.max_bar:
                print(f"[Octuple] reached the last representable bar at note {step}")
                break
            gen = torch.cat([gen, nxt.unsqueeze(0)], dim=0)
            if until_bar is not None and \
                    int(nxt[self.bar_idx].item()) - self.bar0_id >= until_bar:
                break
        out = gen.cpu().numpy()
        self._check_invariants(out[len(prompt_rows):])
        return out

    def _check_invariants(self, rows):
        # The constraints above make violations impossible by construction (except
        # the rare Position fallback); log loudly rather than crash a request.
        if len(rows) == 0:
            return
        bars = rows[:, self.bar_idx]
        if (np.diff(bars) < 0).any():
            print("[Octuple][WARN] invariant violated: bar column decreased")
        same_bar = np.diff(bars) == 0
        if ((np.diff(rows[:, self.pos_idx]) < 0) & same_bar).any():
            print("[Octuple][WARN] invariant violated: position decreased within a bar")
        for f in range(self.num_fields):
            allowed = self.allowed[f][0].cpu().numpy()
            if (~allowed[rows[:, f]]).any():
                print(f"[Octuple][WARN] invariant violated: special token in "
                      f"field {self.idx2name.get(f, f)}")

    def _decode_rows(self, rows):
        ts = TokSequence(ids=[[int(v) for v in r] for r in rows], are_ids_encoded=False)
        try:
            return self.tokenizer.decode(ts)
        except Exception:
            return self.tokenizer.decode([ts])

    def _loop_drum_notes(self, template, drum_idx, tpq, from_bar, to_bar, loop_bars=4):
        """Drums are COPIED and looped, never generated - the dataset builder
        drops drum tracks, so the model has never seen one. Returns notes for
        absolute bars [from_bar, to_bar], times aligned to the pitched tracks."""
        src = template.tracks[drum_idx]
        scale = tpq / template.tpq
        tpb = tpq * _beats_per_bar(template)
        loop_ticks = int(tpb * loop_bars)
        if loop_ticks <= 0:
            return []
        pat = [(int(n.time * scale) % loop_ticks, max(int(n.duration * scale), 1),
                n.pitch, n.velocity)
               for n in src.notes if int(n.time * scale) < loop_ticks * 4]
        if not pat:
            return []
        out = []
        from_tick = int(from_bar * tpb)
        end_tick = int((to_bar + 1) * tpb)
        start = (int(from_bar) // loop_bars) * loop_ticks
        while start < end_tick:
            for off, dur, pitch, vel in pat:
                t = start + off
                if from_tick <= t < end_tick:
                    out.append(Note(time=int(t), duration=int(dur),
                                    pitch=pitch, velocity=vel))
            start += loop_ticks
        return out

    def extend_midi(self, input_midi_path, output_midi_path, num_generate=256, temperature=0.8, top_k=0, top_p=1.0):
        # top_k is accepted for API compatibility but unused: the conditional-head
        # sampler filters with per-field temperature + nucleus (top-p) only.
        template = Score(str(input_midi_path))
        combined = copy.deepcopy(template)

        # Create an empty template that matches the input's track structure
        extension_only = copy.deepcopy(template)
        for tr in extension_only.tracks:
            tr.notes.clear()

        # The job router converts a bar count to tokens as bars*32; recover it.
        # Generating to a shared BAR target (not a fixed note count) keeps dense
        # and sparse tracks ending at the same musical time.
        continue_bars = max(1, int(num_generate) // 32)

        pitched = [i for i, t in enumerate(template.tracks)
                   if not t.is_drum and len(t.notes) > 8][:self.MAX_TRACKS]
        drums = [i for i, t in enumerate(template.tracks)
                 if t.is_drum and len(t.notes) > 4]
        if not pitched:
            raise ValueError("No pitched track has enough notes to extend")

        # Tokenize each pitched track in isolation, keeping ABSOLUTE bar indices
        prompts = {}
        for i in pitched:
            single = copy.deepcopy(template)
            single.tracks = [template.tracks[i]]
            try:
                res = self.tokenizer.encode(single)
                seq = res[0] if isinstance(res, list) else res
                a = np.asarray(seq.ids, dtype=np.int64)
            except Exception as e:
                print(f"[Octuple] track {i}: encode failed ({e})")
                continue
            if a.ndim == 2 and len(a) >= 8:
                prompts[i] = a[-self.PROMPT_NOTES:]
        if not prompts:
            raise ValueError("No pitched track produced a usable Octuple prompt")

        # ONE shared bar offset for every track. Re-basing each track to its own
        # Bar_0 would shift a late-entering part against the rest of the song.
        shift = min(int(a[0, self.bar_idx]) - self.bar0_id for a in prompts.values())
        end_bar = max(int(a[-1, self.bar_idx]) - self.bar0_id
                      for a in prompts.values()) - shift
        target = min(end_bar + continue_bars, self.max_bar - max(shift, 0))
        if target <= end_bar:
            raise ValueError(
                f"Song already ends near bar {end_bar + shift} and the Bar "
                f"vocabulary stops at {self.max_bar} — nothing can be generated")
        print(f"[Octuple] {len(prompts)} pitched tracks | prompt ends bar "
              f"{end_bar + shift} -> generating to bar {target + shift}")

        for i, a in prompts.items():
            a = a.copy()
            a[:, self.bar_idx] -= shift
            try:
                full = self._generate_notes(a, self.MAX_NOTES_PER_TRACK,
                                            temperature, top_p, until_bar=target)
            except Exception as e:
                print(f"[Octuple] track {i}: generation failed ({e})")
                traceback.print_exc()
                continue
            cont = full[len(a):]
            if len(cont) == 0:
                continue
            cont = cont.copy()
            cont[:, self.bar_idx] += shift  # back to the template's absolute frame
            cont = cont[cont[:, self.bar_idx] - self.bar0_id <= self.max_bar]
            if len(cont) == 0:
                continue

            try:
                # Octuple bars are absolute, so the continuation rows alone decode
                # at the correct musical time — no round-trip of the prompt needed,
                # which preserves the template's tempo curves and CCs.
                cont_score = self._decode_rows(cont)
                if not cont_score.tracks:
                    continue

                # Synchronize tick resolutions (decoded Octuple is ~16 tpq)
                if cont_score.tpq != combined.tpq:
                    try: cont_score = cont_score.resample(tpq=combined.tpq)
                    except Exception: cont_score = _rescale_score_inplace(cont_score, combined.tpq)

                if len(cont_score.tracks) > 1:
                    print(f"[Octuple] track {i}: decoded into {len(cont_score.tracks)} "
                          f"tracks (Program varied mid-stream); merging all of them")
                made = 0
                for dtr in cont_score.tracks:
                    for n in dtr.notes:
                        combined.tracks[i].notes.append(n)
                        extension_only.tracks[i].notes.append(copy.deepcopy(n))
                        made += 1

                # Sort events temporally so MIDI parsers do not break
                combined.tracks[i].notes.sort(key=lambda n: getattr(n, 'time', 0))
                extension_only.tracks[i].notes.sort(key=lambda n: getattr(n, 'time', 0))
                print(f"[Octuple] track {i}: {len(a)} prompt + {made} generated notes")
            except Exception as e:
                print(f"Skipping track due to decode error: {e}")

        # Loop the first drum track's pattern across the generated bars
        if drums:
            di = drums[0]
            new_drums = self._loop_drum_notes(template, di, combined.tpq,
                                              from_bar=end_bar + shift + 1,
                                              to_bar=target + shift)
            if new_drums:
                for n in new_drums:
                    combined.tracks[di].notes.append(n)
                    extension_only.tracks[di].notes.append(copy.deepcopy(n))
                combined.tracks[di].notes.sort(key=lambda n: getattr(n, 'time', 0))
                extension_only.tracks[di].notes.sort(key=lambda n: getattr(n, 'time', 0))
                print(f"[Octuple] drums: looped {len(new_drums)} notes across the extension")

        # Normalize time for the extension-only output so it starts at Time=0
        min_time = min((n.time for tr in extension_only.tracks for n in tr.notes), default=0)
        for tr in extension_only.tracks:
            for n in tr.notes: n.time -= min_time

        # Path Setup & Export
        base_path_str = str(output_midi_path).replace(".mid", "")
        full_path = f"{base_path_str}_full.mid"
        ext_path = f"{base_path_str}_extension.mid"
        wav_path = f"{base_path_str}.wav"

        combined.dump_midi(full_path)
        extension_only.dump_midi(ext_path)
        combined.dump_midi(str(output_midi_path))

        soundfont = SOUNDFONT_PATH
        if os.path.exists(soundfont):
            try:
                subprocess.run([FLUIDSYNTH_BIN, "-ni", "-F", wav_path, "-r", "44100", soundfont, full_path], check=True, stdout=subprocess.DEVNULL)
            except Exception as e:
                print(f"FluidSynth error: {e}")

            # Append the completed file path to the batch array
            generated_files.append(f"{base_path_str}{var_suffix}.mid")

        return generated_files
    
    def live_extend(self, notes_data, num_generate=64, temperature=0.8, bpm=120):
        # Real-time jamming endpoint. Designed to be stateless and fast.
        print(f"\n--- [LIVE JAM / OCTUPLE] INCOMING REQUEST ---")
        score = _score_from_live_notes(notes_data, bpm)

        # Tokenize input sequence (one Octuple row per note)
        tok_seq = self.tokenizer.encode(score)
        seq = tok_seq[0] if isinstance(tok_seq, list) else tok_seq
        rows = np.asarray(seq.ids, dtype=np.int64)
        if rows.ndim != 2 or len(rows) == 0: return []
        prompt = rows[-self.PROMPT_NOTES:]

        # Generate new notes (one note per step) and isolate the continuation.
        # _generate_notes re-bases the context internally, so absolute offsets in
        # the incoming clip are handled correctly.
        full = self._generate_notes(prompt, num_generate or 64, temperature, top_p=0.95)
        cont = full[len(prompt):]
        if len(cont) == 0: return []

        # Decode back to symbolic notes and format as JSON array for the frontend
        cont_score = self._decode_rows(cont)
        if not cont_score.tracks: return []

        if cont_score.tpq != 480:
            try:
                cont_score = cont_score.resample(tpq=480)
            except:
                cont_score = _rescale_score_inplace(cont_score, 480)
        return _live_notes_response(cont_score)

# ─── 3. GPT-STYLE MODEL (TSD) ──────────────────────────────────────────────

class _Block(nn.Module):
    """Pre-norm transformer block with causal SDPA attention."""
    # A standard decoder-only Transformer block using modern PyTorch SDPA (Scaled Dot-Product Attention)
    def __init__(self, d_model, n_heads, dropout):
        super().__init__()
        self.n_heads = n_heads
        self.dropout = dropout
        self.norm1 = nn.LayerNorm(d_model)
        # Combined Linear layer for Q, K, V to heavily optimize memory access bandwidth
        self.qkv = nn.Linear(d_model, 3 * d_model, bias=False)
        self.attn_out = nn.Linear(d_model, d_model, bias=False)
        self.norm2 = nn.LayerNorm(d_model)
        self.mlp = nn.Sequential(
            nn.Linear(d_model, 4 * d_model),
            nn.GELU(),
            nn.Linear(4 * d_model, d_model),
            nn.Dropout(dropout),
        )

    def forward(self, x):
        B, L, D = x.shape
        h = self.norm1(x)
        # Split combined QKV tensor into separate chunks
        q, k, v = self.qkv(h).chunk(3, dim=-1)
        q = q.view(B, L, self.n_heads, -1).transpose(1, 2)
        k = k.view(B, L, self.n_heads, -1).transpose(1, 2)
        v = v.view(B, L, self.n_heads, -1).transpose(1, 2)
        
        # Uses FlashAttention algorithms under the hood when available on specific GPU architectures
        a = F.scaled_dot_product_attention(
            q, k, v,
            is_causal=True, # Enforces strict auto-regressive behavior
            dropout_p=self.dropout if self.training else 0.0,
        )
        a = a.transpose(1, 2).reshape(B, L, D)
        x = x + self.attn_out(a)
        x = x + self.mlp(self.norm2(x))
        return x

class ComposerGPT(nn.Module):
    # Generative Pre-Trained Transformer tailored exclusively for 1D symbolic MIDI tokens (TSD strategy)
    def __init__(self, vocab_size, d_model=512, n_layers=8, n_heads=8, max_seq_len=1024, dropout=0.1):
        super().__init__()
        self.max_seq_len = max_seq_len
        self.tok_emb = nn.Embedding(vocab_size, d_model)
        self.pos_emb = nn.Embedding(max_seq_len, d_model) # Learned Positional Embeddings
        self.drop = nn.Dropout(dropout)
        self.blocks = nn.ModuleList(_Block(d_model, n_heads, dropout) for _ in range(n_layers))
        self.norm_f = nn.LayerNorm(d_model)
        self.head = nn.Linear(d_model, vocab_size, bias=False)
        self.head.weight = self.tok_emb.weight # Weight tying: shares memory between input embedding and output projection

        self.apply(self._init)
        # Special initialization scale for residual paths to prevent exploding gradients in deep networks
        for name, p in self.named_parameters():
            if name.endswith("attn_out.weight") or name.endswith("mlp.2.weight"):
                nn.init.normal_(p, mean=0.0, std=0.02 / math.sqrt(2 * n_layers))

    @staticmethod
    def _init(m):
        if isinstance(m, nn.Linear):
            nn.init.normal_(m.weight, mean=0.0, std=0.02)
            if m.bias is not None:
                nn.init.zeros_(m.bias)
        elif isinstance(m, nn.Embedding):
            nn.init.normal_(m.weight, mean=0.0, std=0.02)

    def forward(self, x, hidden=None): 
        B, L = x.shape
        assert L <= self.max_seq_len, f"seq_len {L} > max_seq_len {self.max_seq_len}"
        pos = torch.arange(L, device=x.device)
        
        # Combine Token Identity with Sequence Position
        h = self.drop(self.tok_emb(x) + self.pos_emb(pos))
        for blk in self.blocks:
            h = blk(h)
        return self.head(self.norm_f(h)), None


class AmadeusComposerTSD:
    def __init__(self, checkpoint_path, tokenizer_path):
        # Dynamically targets GPU hardware to avoid CPU bottlenecking
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.tokenizer = TSD(params=Path(tokenizer_path))
        
        ckpt = torch.load(checkpoint_path, map_location=self.device)
        cfg = ckpt["config"]
        self.seq_len = cfg["seq_len"]
        
        # Build an invalid token mask to forcefully stop the model from generating structural metadata as output
        inv = []
        bad_words = ["NONE", "PAD", "BOS", "EOS", "MASK", "UNK"]
        if isinstance(self.tokenizer.vocab, dict):
            for tstr, tid in self.tokenizer.vocab.items():
                if any(bw in tstr.upper() for bw in bad_words):
                    inv.append(tid)
        self.invalid_ids = torch.tensor(inv, dtype=torch.long)
        
        if "pos_emb.weight" in ckpt["model"]:
            weight_seq_len = ckpt["model"]["pos_emb.weight"].shape[0]
        else:
            weight_seq_len = 1024

        self.model = ComposerGPT(
            vocab_size=cfg["vocab_size"], 
            d_model=cfg.get("embed_size", cfg.get("d_model", 512)),
            n_layers=cfg.get("num_layers", cfg.get("n_layers", 8)),
            n_heads=cfg.get("num_heads", cfg.get("n_heads", 8)),
            max_seq_len=weight_seq_len,
            dropout=cfg.get("dropout", 0.0)
        ).to(self.device)
        
        self.model.load_state_dict(ckpt["model"])
        self.model.eval()

    @torch.no_grad()
    def _generate_tokens(self, prompt_ids, num_tokens, temperature, top_k, top_p):
        temperature = temperature or 0.8
        top_k = top_k or 0
        top_p = top_p or 1.0
        inv_mask = self.invalid_ids.to(self.device)
        seq = torch.tensor(list(prompt_ids), dtype=torch.long, device=self.device)
        
        for _ in range(num_tokens):
            context = seq[-self.seq_len:].unsqueeze(0)
            logits, _ = self.model(context)
            next_logits = logits[0, -1].float()
            
            # Apply logical mask to prevent invalid structural tokens from appearing
            if len(inv_mask) > 0: next_logits[inv_mask] = -float("inf")
            next_logits = next_logits / max(temperature, 1e-8)
            
            # Filtering logic for K/P sampling limits the AI to realistic choices
            if top_k > 0:
                indices_to_remove = next_logits < torch.topk(next_logits, top_k)[0][..., -1, None]
                next_logits[indices_to_remove] = -float('Inf')
            if top_p < 1.0:
                sorted_logits, sorted_indices = torch.sort(next_logits, descending=True)
                cumulative_probs = torch.cumsum(F.softmax(sorted_logits, dim=-1), dim=-1)
                sorted_indices_to_remove = cumulative_probs > top_p
                # Shift mask logic: keeps the exact token that pushes cumulative probability over Top-P
                sorted_indices_to_remove[..., 1:] = sorted_indices_to_remove[..., :-1].clone()
                sorted_indices_to_remove[..., 0] = 0
                indices_to_remove = sorted_indices[sorted_indices_to_remove]
                next_logits[indices_to_remove] = -float('Inf')
            
            probs = F.softmax(next_logits, dim=-1)
            next_id = torch.multinomial(probs, num_samples=1).squeeze()
            seq = torch.cat([seq, next_id.unsqueeze(0)])
        return seq.tolist()

    def extend_midi(self, input_midi_path, output_midi_path, num_generate=256, temperature=0.8, top_k=0, top_p=1.0, num_variations=1):
        """
        Executes the auto-regressive generation pipeline utilizing the Time-Shift Duration (TSD) tokenization strategy.
        TSD unrolls musical events into a 1D sequence (Pitch -> Velocity -> Duration -> TimeShift), 
        mirroring the structure of Natural Language Processing (NLP) models.
        """
        template = Score(str(input_midi_path))
        
        # 1. PROMPT PREPARATION
        # Extract the sequence to prime the transformer's hidden state.
        single = copy.deepcopy(template)
        if len(single.tracks) > 0: single.tracks = [single.tracks[0]]
        tok_seq = self.tokenizer(single)
        
        # Flatten the TokSequence into a 1D array of integers
        ids = tok_seq[0].ids if isinstance(tok_seq, list) else tok_seq.ids
        prompt = ids[-256:] 
        if not prompt: return []

        generated_files = []
        base_path_str = str(output_midi_path).replace(".mid", "")

        # 2. STOCHASTIC VARIATION LOOP
        # Iterates through the requested variations. Given the same prompt, the sampler will 
        # explore different local minima based on the Temperature and Top-P probability masks.
        for v_idx in range(num_variations):
            var_suffix = f"_var{v_idx+1}" if num_variations > 1 else ""
            
            combined = copy.deepcopy(template)
            extension_only = copy.deepcopy(template)
            for tr in extension_only.tracks:
                tr.notes.clear()

            # Execute the auto-regressive prediction loop over the causal language model
            full_ids = self._generate_tokens(prompt, num_generate, temperature, top_k, top_p)
            cont_ids = full_ids[len(prompt):]
            
            if cont_ids:
                # 3. SEQUENCE DECODING
                # TSD sequences require the `are_ids_encoded=True` flag to signal the 
                # MidiTok dictionary to map the 1D integers back to categorical events
                new_tok_seq = TokSequence(ids=cont_ids, are_ids_encoded=True)
                if hasattr(self.tokenizer, "decode_token_ids"): self.tokenizer.decode_token_ids(new_tok_seq)
                self.tokenizer.complete_sequence(new_tok_seq)
                
                try:
                    # Construct a symbolic score from the sequence of categorized tokens
                    cont_score = self.tokenizer.decode([new_tok_seq])
                    if cont_score.tracks:
                        
                        # Re-align temporal resolution (TPQ) to match the input framework
                        if cont_score.tpq != combined.tpq:
                            try: cont_score = cont_score.resample(tpq=combined.tpq)
                            except: cont_score = _rescale_score_inplace(cont_score, combined.tpq)
                        
                        # Populate the output templates with the newly generated Note objects
                        for i, tr in enumerate(template.tracks):
                            if len(tr.notes) == 0: continue
                            for n in cont_score.tracks[0].notes:
                                t, d = getattr(n, 'time', None), getattr(n, 'duration', None)
                                if t is not None and d is not None and isinstance(t, int) and isinstance(d, int):
                                    combined.tracks[i].notes.append(n)
                                    extension_only.tracks[i].notes.append(copy.deepcopy(n))
                            
                            # Enforce chronological ordering for standard MIDI parser compliance
                            combined.tracks[i].notes.sort(key=lambda n: getattr(n, 'time', 0))
                            extension_only.tracks[i].notes.sort(key=lambda n: getattr(n, 'time', 0))
                except Exception as e:
                    print(f"Skipping track due to decode error: {e}")
                    
            # 4. TEMPORAL NORMALIZATION
            # Anchor the generated segment to t=0 for isolated playback and analysis
            min_time = min((n.time for tr in extension_only.tracks for n in tr.notes), default=0)
            for tr in extension_only.tracks:
                for n in tr.notes: n.time -= min_time

        # Export and Render
        base_path_str = str(output_midi_path).replace(".mid", "")
        full_path = f"{base_path_str}_full.mid"
        ext_path = f"{base_path_str}_extension.mid"
        wav_path = f"{base_path_str}.wav"
        
        combined.dump_midi(full_path)
        extension_only.dump_midi(ext_path)
        
        soundfont = SOUNDFONT_PATH
        if os.path.exists(soundfont):
            try:
                subprocess.run([FLUIDSYNTH_BIN, "-ni", "-F", wav_path, "-r", "44100", soundfont, full_path], check=True, stdout=subprocess.DEVNULL)
            except Exception as e:
                print(f"FluidSynth error: {e}")

            generated_files.append(f"{base_path_str}{var_suffix}.mid")

        return generated_files