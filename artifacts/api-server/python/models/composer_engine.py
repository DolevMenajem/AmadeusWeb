import os
import copy
import math
import torch
import torch.nn as nn
import torch.nn.functional as F
from pathlib import Path
from miditok import REMI, Octuple, TSD, TokSequence
from symusic import Score, Track, Note, Tempo, TimeSignature
import tempfile
import subprocess
import traceback

from .jam_inference import JamModel

# ─── SHARED UTILITIES FOR MULTI-TRACK ────────────────────────────────────────

def _rescale_score_inplace(score, dst_tpq):
    # Adjusts the Ticks Per Quarter (TPQ) resolution of a MIDI score.
    # ML models often require a specific grid resolution (e.g., 480 TPQ).
    if score.tpq == dst_tpq: return score
    scale = dst_tpq / score.tpq
    for tr in score.tracks:
        for n in tr.notes:
            # Scale the start time and duration by the resolution ratio
            n.time = int(round(n.time * scale))
            n.duration = max(1, int(round(n.duration * scale)))
    score.tpq = dst_tpq
    return score

class Attention(nn.Module):
    # Standard Multi-Head Self-Attention wrapper used by the Octuple hybrid model.
    def __init__(self, hidden_dim, num_heads=8, dropout=0.0):
        super().__init__()
        self.mha = nn.MultiheadAttention(embed_dim=hidden_dim, num_heads=num_heads, dropout=dropout, batch_first=True)
        self.norm = nn.LayerNorm(hidden_dim)

    def forward(self, x):
        seq_len = x.size(1)
        # Create a causal mask (upper triangular) to prevent the model from looking into the future
        causal_mask = torch.triu(torch.ones(seq_len, seq_len, device=x.device, dtype=torch.bool), diagonal=1)
        attn_out, _ = self.mha(query=x, key=x, value=x, attn_mask=causal_mask, need_weights=False)
        # Add residual connection and apply layer normalization
        return self.norm(x + attn_out)

# ─── 1. UPGRADED REMI MODEL (BIFG GPT via JamModel) ─────────────────────────

class AmadeusComposerREMI:
    # Wrapper for the primary Single-Track model, leaning on an external JamModel architecture
    def __init__(self, checkpoint_path, tokenizer_path):
        # Dynamically assigns processing to GPU if available to speed up matrix multiplication
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"Loading Upgraded REMI JamModel from {checkpoint_path} on {self.device}...")
        self.jam = JamModel(
            checkpoint_path=str(checkpoint_path),
            tokenizer_path=str(tokenizer_path),
            device=self.device
        )

    def extend_midi(self, input_midi_path, output_midi_path, num_generate=256, temperature=0.8, top_k=0, top_p=1.0):
        try:
            # Convert token count to approximate musical bars (assuming ~32 tokens per bar)
            bars_to_extend = max(1, num_generate // 32)
            temp = temperature if temperature is not None else 0.8
            p = top_p if top_p is not None else 0.9

            print(f"[REMI] Continuing song for {bars_to_extend} bars...")

            # Generate full extended score (prompt + extension)
            # include_prompt=True stitches the original input to the new generation
            full_score, info = self.jam.continue_song(
                midi=str(input_midi_path),
                n_bars=bars_to_extend,
                temperature=temp,
                top_p=p,
                include_prompt=True,
                progress=False
            )

            # Generate isolated extension only (without prompt)
            # include_prompt=False returns ONLY the AI's continuation
            ext_score, _ = self.jam.continue_song(
                midi=str(input_midi_path),
                n_bars=bars_to_extend,
                temperature=temp,
                top_p=p,
                include_prompt=False,
                progress=False
            )

            # Prepare file output paths
            base_path_str = str(output_midi_path).replace(".mid", "")
            full_path = f"{base_path_str}_full.mid"
            ext_path = f"{base_path_str}_extension.mid"
            wav_path = f"{base_path_str}.wav"

            # Save MIDI files to disk
            full_score.dump_midi(full_path)
            ext_score.dump_midi(ext_path)
            full_score.dump_midi(str(output_midi_path))

            # Render Audio with FluidSynth
            # Uses a standard General MIDI (GM) SoundFont to synthesize audio
            soundfont = "/usr/share/sounds/sf2/FluidR3_GM.sf2"
            if os.path.exists(soundfont):
                try:
                    # Executes the FluidSynth CLI tool as a subprocess to render a 44.1kHz WAV
                    subprocess.run(
                        ["fluidsynth", "-ni", soundfont, full_path, "-F", wav_path, "-r", "44100"],
                        check=True,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL
                    )
                except Exception as e:
                    print(f"FluidSynth error: {e}")

            print(f"[REMI] Completed successfully. Info: {info}")
            return output_midi_path

        except Exception as e:
            print(f"[REMI ERROR] Failed to generate: {e}")
            traceback.print_exc()
            raise e


# ─── 2. NEW MULTI-TRACK MODEL (OCTUPLE) ───────────────────────────────────────

class ComposerMidiOctuple(nn.Module):
    # Hybrid LSTM + Attention architecture designed specifically for the Octuple tokenization strategy
    # Octuple uses multi-dimensional tokens (pitch, velocity, duration, etc. are passed simultaneously)
    def __init__(self, sub_vocab_sizes, embed_size, hidden_size, num_layers=2, num_heads=8, dropout=0.1):
        super().__init__()
        self.sub_vocab_sizes = list(sub_vocab_sizes)
        self.num_streams = len(self.sub_vocab_sizes) # Number of independent token streams (e.g., 8 for Octuple)
        
        # Create an independent embedding layer for each stream in the token tuple
        self.embeddings = nn.ModuleList([nn.Embedding(v, embed_size) for v in self.sub_vocab_sizes])
        self.embed_dropout = nn.Dropout(dropout)
        
        # Core sequence modeling: RNN (LSTM) handles local time, Attention handles global context
        self.lstm = nn.LSTM(embed_size, hidden_size, num_layers, batch_first=True, dropout=dropout if num_layers > 1 else 0.0)
        self.attention = Attention(hidden_size, num_heads=num_heads, dropout=dropout)
        
        # Output heads: Decodes the hidden state back into probabilities for EACH stream independently
        self.heads = nn.ModuleList([nn.Linear(hidden_size, v) for v in self.sub_vocab_sizes])

    def forward(self, x, hidden=None):
        # x shape: [Batch, Sequence_Length, Streams]
        # Sum the embeddings of all streams together to create a unified token representation
        embedded = self.embeddings[0](x[..., 0])
        for s in range(1, self.num_streams):
            embedded = embedded + self.embeddings[s](x[..., s])
            
        embedded = self.embed_dropout(embedded)
        lstm_out, hidden = self.lstm(embedded, hidden)
        attended = self.attention(lstm_out)
        
        # Generate independent predictions for each part of the Octuple tuple
        logits = [head(attended) for head in self.heads]
        return logits, hidden

class AmadeusComposerOctuple:
    def __init__(self, checkpoint_path, tokenizer_path):
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")    

        # Setup MidiTok Octuple tokenizer
        target_path = Path(tokenizer_path).parent / "Compose_Octuple.json"
        if target_path.exists():
            self.tokenizer = Octuple(params=target_path)
        else:
            self.tokenizer = Octuple(params=Path(tokenizer_path))
            
        # Load weights and extract configuration metadata
        ckpt = torch.load(checkpoint_path, map_location=self.device)
        cfg = ckpt["config"]
        self.seq_len = cfg["seq_len"]
        
        self.sub_vocab_sizes = [len(v) for v in self.tokenizer.vocab]
        self.num_streams = len(self.sub_vocab_sizes)
        
        # Identify the specific index for 'Bar' tokens. 
        # This is critical to prevent the model from generating infinitely into the future.
        self.bar_stream_idx = self.tokenizer.vocab_types_idx.get("Bar", 2)
        bar_vocab = self.tokenizer.vocab[self.bar_stream_idx]
        self.bar_values = torch.full((len(bar_vocab),), -1, dtype=torch.long, device=self.device)
        
        # Extract integer values from Bar tokens (e.g., "Bar_5" -> 5)
        for tok_str, tid in bar_vocab.items():
            parts = tok_str.split("_", 1)
            if len(parts) == 2:
                try: self.bar_values[tid] = int(parts[1])
                except ValueError: pass

        self.model = ComposerMidiOctuple(
            sub_vocab_sizes=self.sub_vocab_sizes, embed_size=cfg["embed_size"],
            hidden_size=cfg["hidden_size"], num_layers=cfg["num_layers"], dropout=cfg.get("dropout", 0.0)
        ).to(self.device)
        self.model.load_state_dict(ckpt["model"])
        self.model.eval()

    def _sample_one_stream(self, logits_1d, temperature, top_k, top_p):
        # Applies temperature scaling to flatten or sharpen the probability distribution
        temperature = temperature or 0.8
        logits_1d = logits_1d / max(temperature, 1e-8)
        
        # Top-K Sampling: Zero out all probabilities outside the top K highest values
        if top_k and top_k > 0:
            k = min(top_k, logits_1d.size(-1))
            v, _ = torch.topk(logits_1d, k)
            logits_1d = logits_1d.clone()
            logits_1d[logits_1d < v[-1]] = -float("inf")
            
        # Nucleus (Top-P) Sampling: Filter out tokens whose cumulative probability exceeds P
        if top_p and 0 < top_p < 1.0:
            sorted_logits, sorted_idx = torch.sort(logits_1d, descending=True)
            cum = torch.cumsum(F.softmax(sorted_logits, dim=-1), dim=-1)
            remove = cum > top_p
            remove[1:] = remove[:-1].clone() # Shift mask to keep the token that crosses the threshold
            remove[0] = False
            sorted_logits[remove] = -float("inf")
            logits_1d = torch.full_like(logits_1d, -float("inf"))
            logits_1d.scatter_(0, sorted_idx, sorted_logits)
            
        # Convert filtered logits to probabilities and sample a single token
        probs = F.softmax(logits_1d, dim=-1)
        return int(torch.multinomial(probs, num_samples=1))

    @torch.no_grad()
    def _generate_tokens(self, prompt_ids, num_tokens, temperature, top_k, top_p, max_bar_window=2):
        # Auto-regressive generation loop for multidimensional tokens
        seq = torch.tensor([list(t) for t in prompt_ids], dtype=torch.long, device=self.device)
        
        # Determine the starting measure (Bar) so we can control how far ahead we generate
        prompt_bar_vals = self.bar_values[seq[:, self.bar_stream_idx]]
        valid = prompt_bar_vals >= 0
        max_bar = int(prompt_bar_vals[valid].max()) if valid.any() else 0
        
        for _ in range(num_tokens):
            # Feed the last N tokens into the model (context window)
            context = seq[-self.seq_len:].unsqueeze(0)
            logits, _ = self.model(context)
            
            next_tuple = []
            # Sample each stream (Pitch, Velocity, Bar, etc.) one by one
            for s in range(self.num_streams):
                next_logits = logits[s][0, -1].float().clone()
                
                # Hard constraint: Prevent generating a Bar token that exceeds our window
                if s == self.bar_stream_idx:
                    threshold = max_bar + max_bar_window
                    too_far = self.bar_values > threshold
                    next_logits[too_far] = -float("inf")
                
                next_id = self._sample_one_stream(next_logits, temperature, top_k, top_p)
                next_tuple.append(next_id)
                
                # Update the max bar tracker if we just generated a new measure
                if s == self.bar_stream_idx:
                    val = int(self.bar_values[next_id])
                    if val > max_bar: max_bar = val
                    
            # Append the completed multi-dimensional token to the sequence
            seq = torch.cat([seq, torch.tensor([next_tuple], dtype=torch.long, device=self.device)], dim=0)
        return seq.tolist()

    def extend_midi(self, input_midi_path, output_midi_path, num_generate=256, temperature=0.8, top_k=0, top_p=1.0):
        # Load the initial MIDI to use as a structural template
        template = Score(str(input_midi_path))
        combined = copy.deepcopy(template)
        
        # Create an empty template that matches the input's track structure
        extension_only = copy.deepcopy(template)
        for tr in extension_only.tracks:
            tr.notes.clear()

        # Iterate through every track (instrument) and extend them individually
        for i, tr in enumerate(template.tracks):
            if len(tr.notes) == 0: continue
            
            # Isolate track and tokenize
            single = copy.deepcopy(template)
            single.tracks = [tr]
            tok_seq = self.tokenizer(single)
            
            ids = []
            if isinstance(tok_seq, list):
                for ts in tok_seq: ids.extend(ts.ids)
            else:
                ids = list(tok_seq.ids)
                
            # Limit the prompt to the model's context window (last 256 tokens)
            prompt = ids[-256:] 
            if not prompt: continue
            
            # Execute inference
            full_ids = self._generate_tokens(prompt, num_generate, temperature, top_k, top_p, max_bar_window=100)
            cont_ids = full_ids[len(prompt):] # Slice out the prompt, keeping only new tokens
            if not cont_ids: continue
            
            new_tok_seq = TokSequence(ids=[list(t) for t in cont_ids])
            self.tokenizer.complete_sequence(new_tok_seq)
            
            try:
                # Convert back to symbolic MIDI data
                cont_score = self.tokenizer.decode([new_tok_seq])
                if not cont_score.tracks: continue
                
                # Synchronize Tick resolutions
                if cont_score.tpq != combined.tpq:
                    try: cont_score = cont_score.resample(tpq=combined.tpq)
                    except: cont_score = _rescale_score_inplace(cont_score, combined.tpq)
                
                # Append the newly generated notes into their respective tracks
                for n in cont_score.tracks[0].notes:
                    t = getattr(n, 'time', None)
                    d = getattr(n, 'duration', None)
                    if t is not None and d is not None and isinstance(t, int) and isinstance(d, int):
                        combined.tracks[i].notes.append(n)
                        extension_only.tracks[i].notes.append(copy.deepcopy(n))
                
                # Sort events temporally so MIDI parsers do not break
                combined.tracks[i].notes.sort(key=lambda n: getattr(n, 'time', 0))
                extension_only.tracks[i].notes.sort(key=lambda n: getattr(n, 'time', 0))
            except Exception as e:
                # Issue: Silently skipping a track can result in missing instruments without the user knowing
                print(f"Skipping track due to decode error: {e}")
                
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
        
        soundfont = "/usr/share/sounds/sf2/FluidR3_GM.sf2"
        if os.path.exists(soundfont):
            try:
                subprocess.run(["fluidsynth", "-ni", soundfont, full_path, "-F", wav_path, "-r", "44100"], check=True, stdout=subprocess.DEVNULL)
            except Exception as e:
                print(f"FluidSynth error: {e}")

        return output_midi_path

    def live_extend(self, notes_data, num_generate=64, temperature=0.8, bpm=120):
        # Real-time jamming endpoint. Designed to be stateless and fast.
        print(f"\n--- [LIVE JAM] INCOMING REQUEST ---")
        
        # 1. Create a dummy Score object to hold incoming browser data
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
        
        # 2. Write to a temporary file (Symusic requires file I/O for instantiation)
        fd, path = tempfile.mkstemp(suffix=".mid")
        os.close(fd)
        raw_score.dump_midi(path)
        
        score = Score(path)
        os.remove(path) # Cleanup immediately
        
        # 3. Tokenize input sequence
        tok_seq = self.tokenizer(score)
        ids = []
        if isinstance(tok_seq, list):
            for ts in tok_seq: ids.extend(ts.ids)
        else:
            ids = list(tok_seq.ids)
            
        prompt = ids[-256:]
        if not prompt: return []
        
        # 4. Generate new notes and isolate the continuation
        full_ids = self._generate_tokens(prompt, num_generate, temperature, top_k=0, top_p=0.95, max_bar_window=100)
        cont_ids = full_ids[len(prompt):]
        if not cont_ids: return []
        
        new_tok_seq = TokSequence(ids=[list(t) for t in cont_ids])
        self.tokenizer.complete_sequence(new_tok_seq)
        
        # 5. Decode back to symbolic notes and format as JSON array for the frontend
        cont_score = self.tokenizer.decode([new_tok_seq])
        if not cont_score.tracks: return []
        
        if cont_score.tpq != 480:
            try: 
                cont_score = cont_score.resample(tpq=480)
            except: 
                cont_score = _rescale_score_inplace(cont_score, 480)
                
        response_notes = []
        raw_notes = cont_score.tracks[0].notes
        
        if len(raw_notes) > 0:
            min_time = min(getattr(n, 'time', 0) for n in raw_notes)
            for n in raw_notes:
                n_time = getattr(n, 'time', 0)
                response_notes.append({
                    "pitch": getattr(n, 'pitch', 60),
                    "time": n_time - min_time, # Normalize time for instant playback
                    "duration": getattr(n, 'duration', 120),
                    "velocity": getattr(n, 'velocity', 80)
                })
                    
        return response_notes

# ─── 3. GPT-STYLE MODEL (TSD) ──────────────────────────────────────────────

class _Block(nn.Module):
    """Pre-norm transformer block with causal SDPA attention."""
    # A standard decoder-only Transformer block using modern PyTorch SDPA 
    def __init__(self, d_model, n_heads, dropout):
        super().__init__()
        self.n_heads = n_heads
        self.dropout = dropout
        self.norm1 = nn.LayerNorm(d_model)
        # Combined Linear layer for Q, K, V to optimize memory access
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
        
        # Uses FlashAttention algorithms under the hood when available on GPU
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
    # Generative Pre-Trained Transformer tailored for 1D symbolic MIDI tokens (TSD strategy)
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
        # Special initialization scale for residual paths to prevent exploding gradients
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
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.tokenizer = TSD(params=Path(tokenizer_path))
        
        ckpt = torch.load(checkpoint_path, map_location=self.device)
        cfg = ckpt["config"]
        self.seq_len = cfg["seq_len"]
        
        # Build an invalid token mask to stop the model from generating structural metadata as output
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
            
            # Mask out invalid structural tokens
            if len(inv_mask) > 0: next_logits[inv_mask] = -float("inf")
            next_logits = next_logits / max(temperature, 1e-8)
            
            # Filtering logic for K/P sampling
            if top_k > 0:
                indices_to_remove = next_logits < torch.topk(next_logits, top_k)[0][..., -1, None]
                next_logits[indices_to_remove] = -float('Inf')
            if top_p < 1.0:
                sorted_logits, sorted_indices = torch.sort(next_logits, descending=True)
                cumulative_probs = torch.cumsum(F.softmax(sorted_logits, dim=-1), dim=-1)
                sorted_indices_to_remove = cumulative_probs > top_p
                # Shift mask logic: keeps the exact token that pushes cumulative prob over Top-P
                sorted_indices_to_remove[..., 1:] = sorted_indices_to_remove[..., :-1].clone()
                sorted_indices_to_remove[..., 0] = 0
                indices_to_remove = sorted_indices[sorted_indices_to_remove]
                next_logits[indices_to_remove] = -float('Inf')
            
            probs = F.softmax(next_logits, dim=-1)
            next_id = torch.multinomial(probs, num_samples=1).squeeze()
            seq = torch.cat([seq, next_id.unsqueeze(0)])
        return seq.tolist()

    def extend_midi(self, input_midi_path, output_midi_path, num_generate=256, temperature=0.8, top_k=0, top_p=1.0):
        # Base setup logic identical to Octuple: create working copies and clear extension tracks
        template = Score(str(input_midi_path))
        combined = copy.deepcopy(template)
        extension_only = copy.deepcopy(template)
        for tr in extension_only.tracks:
            tr.notes.clear()

        for i, tr in enumerate(template.tracks):
            if len(tr.notes) == 0: continue
            
            single = copy.deepcopy(template)
            single.tracks = [tr]
            tok_seq = self.tokenizer(single)
            
            ids = tok_seq[0].ids if isinstance(tok_seq, list) else tok_seq.ids
            prompt = ids[-256:] 
            if not prompt: continue
            
            # Sequence Generation
            full_ids = self._generate_tokens(prompt, num_generate, temperature, top_k, top_p)
            cont_ids = full_ids[len(prompt):]
            if not cont_ids: continue
            
            # The TSD tokenizer requires boolean flags to correctly decode 1D tokens
            new_tok_seq = TokSequence(ids=cont_ids, are_ids_encoded=True)
            if hasattr(self.tokenizer, "decode_token_ids"): self.tokenizer.decode_token_ids(new_tok_seq)
            self.tokenizer.complete_sequence(new_tok_seq)
            
            try:
                cont_score = self.tokenizer.decode([new_tok_seq])
                if not cont_score.tracks: continue
                
                if cont_score.tpq != combined.tpq:
                    try: cont_score = cont_score.resample(tpq=combined.tpq)
                    except: cont_score = _rescale_score_inplace(cont_score, combined.tpq)
                
                for n in cont_score.tracks[0].notes:
                    t = getattr(n, 'time', None)
                    d = getattr(n, 'duration', None)
                    if t is not None and d is not None and isinstance(t, int) and isinstance(d, int):
                        combined.tracks[i].notes.append(n)
                        extension_only.tracks[i].notes.append(copy.deepcopy(n))
                
                combined.tracks[i].notes.sort(key=lambda n: getattr(n, 'time', 0))
                extension_only.tracks[i].notes.sort(key=lambda n: getattr(n, 'time', 0))
            except Exception as e:
                print(f"Skipping track due to decode error: {e}")
                
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
        
        soundfont = "/usr/share/sounds/sf2/FluidR3_GM.sf2"
        if os.path.exists(soundfont):
            try:
                subprocess.run(["fluidsynth", "-ni", soundfont, full_path, "-F", wav_path, "-r", "44100"], check=True, stdout=subprocess.DEVNULL)
            except Exception as e:
                print(f"FluidSynth error: {e}")

        return output_midi_path