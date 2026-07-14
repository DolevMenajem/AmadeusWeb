import os
import copy
import torch
import torch.nn as nn
import torch.nn.functional as F
from pathlib import Path
from miditok import REMI, Octuple, TokSequence
from symusic import Score, Track, Note, Tempo, TimeSignature
import tempfile

# ─── SHARED UTILITIES FOR MULTI-TRACK ────────────────────────────────────────

def _rescale_score_inplace(score, dst_tpq):
    if score.tpq == dst_tpq: return score
    scale = dst_tpq / score.tpq
    for tr in score.tracks:
        for n in tr.notes:
            n.time = int(round(n.time * scale))
            n.duration = max(1, int(round(n.duration * scale)))
    score.tpq = dst_tpq
    return score

class Attention(nn.Module):
    def __init__(self, hidden_dim, num_heads=8, dropout=0.0):
        super().__init__()
        self.mha = nn.MultiheadAttention(embed_dim=hidden_dim, num_heads=num_heads, dropout=dropout, batch_first=True)
        self.norm = nn.LayerNorm(hidden_dim)

    def forward(self, x):
        seq_len = x.size(1)
        causal_mask = torch.triu(torch.ones(seq_len, seq_len, device=x.device, dtype=torch.bool), diagonal=1)
        attn_out, _ = self.mha(query=x, key=x, value=x, attn_mask=causal_mask, need_weights=False)
        return self.norm(x + attn_out)

# ─── 1. STANDARD MODEL (REMI) ──────────────────────────────────────────

class ComposerMidiREMI(nn.Module):
    def __init__(self, vocab_size, embed_size, hidden_size, num_layers=2, num_heads=8, dropout=0.1):
        super().__init__()
        self.embedding = nn.Embedding(vocab_size, embed_size)
        self.embed_dropout = nn.Dropout(dropout)
        self.lstm = nn.LSTM(embed_size, hidden_size, num_layers, batch_first=True, dropout=dropout if num_layers > 1 else 0.0)
        self.attention = Attention(hidden_size, num_heads=num_heads, dropout=dropout)
        self.fc_out = nn.Linear(hidden_size, vocab_size)

    def forward(self, x, hidden=None):
        embedded = self.embed_dropout(self.embedding(x))
        lstm_out, hidden = self.lstm(embedded, hidden)
        attended = self.attention(lstm_out)
        logits = self.fc_out(attended)
        return logits, hidden

class AmadeusComposerREMI:
    def __init__(self, checkpoint_path, tokenizer_path):
        self.device = torch.device("cpu")
        self.tokenizer = REMI(params=Path(tokenizer_path))
        ckpt = torch.load(checkpoint_path, map_location=self.device)
        cfg = ckpt["config"]
        self.seq_len = cfg["seq_len"]
        
        inv = []
        bad_words = ["NONE", "PAD", "BOS", "EOS", "MASK", "UNK"]
        if isinstance(self.tokenizer.vocab, dict):
            for tstr, tid in self.tokenizer.vocab.items():
                if any(bw in tstr.upper() for bw in bad_words):
                    inv.append(tid)
        self.invalid_ids = torch.tensor(inv, dtype=torch.long)
        
        self.model = ComposerMidiREMI(
            vocab_size=cfg["vocab_size"], embed_size=cfg["embed_size"],
            hidden_size=cfg["hidden_size"], num_layers=cfg["num_layers"], dropout=cfg.get("dropout", 0.0)
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
            
            if len(inv_mask) > 0: next_logits[inv_mask] = -float("inf")
            next_logits = next_logits / max(temperature, 1e-8)
            
            if top_k > 0:
                indices_to_remove = next_logits < torch.topk(next_logits, top_k)[0][..., -1, None]
                next_logits[indices_to_remove] = -float('Inf')
            if top_p < 1.0:
                sorted_logits, sorted_indices = torch.sort(next_logits, descending=True)
                cumulative_probs = torch.cumsum(F.softmax(sorted_logits, dim=-1), dim=-1)
                sorted_indices_to_remove = cumulative_probs > top_p
                sorted_indices_to_remove[..., 1:] = sorted_indices_to_remove[..., :-1].clone()
                sorted_indices_to_remove[..., 0] = 0
                indices_to_remove = sorted_indices[sorted_indices_to_remove]
                next_logits[indices_to_remove] = -float('Inf')
            
            probs = F.softmax(next_logits, dim=-1)
            next_id = torch.multinomial(probs, num_samples=1).squeeze()
            seq = torch.cat([seq, next_id.unsqueeze(0)])
        return seq.tolist()

    def extend_midi(self, input_midi_path, output_midi_path, num_generate=256, temperature=0.8, top_k=0, top_p=1.0):
        import subprocess
        
        template = Score(str(input_midi_path))
        combined = copy.deepcopy(template)
        
        # Create a blank canvas for the isolated extension
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
            
            # REMI does not use max_bar_window
            full_ids = self._generate_tokens(prompt, num_generate, temperature, top_k, top_p)
            cont_ids = full_ids[len(prompt):]
            if not cont_ids: continue
            
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
                
        # Shift isolated extension to 0:00
        min_time = min((n.time for tr in extension_only.tracks for n in tr.notes), default=0)
        for tr in extension_only.tracks:
            for n in tr.notes: n.time -= min_time

        # Save files
        base_path_str = str(output_midi_path).replace(".mid", "")
        full_path = f"{base_path_str}_full.mid"
        ext_path = f"{base_path_str}_extension.mid"
        wav_path = f"{base_path_str}.wav"
        
        combined.dump_midi(full_path)
        extension_only.dump_midi(ext_path)
        
        # Render Audio
        soundfont = "/usr/share/sounds/sf2/FluidR3_GM.sf2"
        try:
            subprocess.run(["fluidsynth", "-ni", soundfont, full_path, "-F", wav_path, "-r", "44100"], check=True, stdout=subprocess.DEVNULL)
        except Exception as e:
            print(f"FluidSynth error: {e}")

        return output_midi_path


# ─── 2. NEW MULTI-TRACK MODEL (OCTUPLE) ───────────────────────────────────────

class ComposerMidiOctuple(nn.Module):
    def __init__(self, sub_vocab_sizes, embed_size, hidden_size, num_layers=2, num_heads=8, dropout=0.1):
        super().__init__()
        self.sub_vocab_sizes = list(sub_vocab_sizes)
        self.num_streams = len(self.sub_vocab_sizes)
        self.embeddings = nn.ModuleList([nn.Embedding(v, embed_size) for v in self.sub_vocab_sizes])
        self.embed_dropout = nn.Dropout(dropout)
        self.lstm = nn.LSTM(embed_size, hidden_size, num_layers, batch_first=True, dropout=dropout if num_layers > 1 else 0.0)
        self.attention = Attention(hidden_size, num_heads=num_heads, dropout=dropout)
        self.heads = nn.ModuleList([nn.Linear(hidden_size, v) for v in self.sub_vocab_sizes])

    def forward(self, x, hidden=None):
        embedded = self.embeddings[0](x[..., 0])
        for s in range(1, self.num_streams):
            embedded = embedded + self.embeddings[s](x[..., s])
        embedded = self.embed_dropout(embedded)
        lstm_out, hidden = self.lstm(embedded, hidden)
        attended = self.attention(lstm_out)
        logits = [head(attended) for head in self.heads]
        return logits, hidden

class AmadeusComposerOctuple:
    def __init__(self, checkpoint_path, tokenizer_path):
        self.device = torch.device("cpu")
        
        # Determine the correct Octuple JSON file path dynamically
        target_path = Path(tokenizer_path).parent / "Compose_Octuple.json"
        if target_path.exists():
            self.tokenizer = Octuple(params=target_path)
        else:
            self.tokenizer = Octuple(params=Path(tokenizer_path))
            
        ckpt = torch.load(checkpoint_path, map_location=self.device)
        cfg = ckpt["config"]
        self.seq_len = cfg["seq_len"]
        
        self.sub_vocab_sizes = [len(v) for v in self.tokenizer.vocab]
        self.num_streams = len(self.sub_vocab_sizes)
        
        # Build bar mapping array for window logic
        self.bar_stream_idx = self.tokenizer.vocab_types_idx.get("Bar", 2)
        bar_vocab = self.tokenizer.vocab[self.bar_stream_idx]
        self.bar_values = torch.full((len(bar_vocab),), -1, dtype=torch.long, device=self.device)
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
        temperature = temperature or 0.8
        logits_1d = logits_1d / max(temperature, 1e-8)
        if top_k and top_k > 0:
            k = min(top_k, logits_1d.size(-1))
            v, _ = torch.topk(logits_1d, k)
            logits_1d = logits_1d.clone()
            logits_1d[logits_1d < v[-1]] = -float("inf")
        if top_p and 0 < top_p < 1.0:
            sorted_logits, sorted_idx = torch.sort(logits_1d, descending=True)
            cum = torch.cumsum(F.softmax(sorted_logits, dim=-1), dim=-1)
            remove = cum > top_p
            remove[1:] = remove[:-1].clone()
            remove[0] = False
            sorted_logits[remove] = -float("inf")
            logits_1d = torch.full_like(logits_1d, -float("inf"))
            logits_1d.scatter_(0, sorted_idx, sorted_logits)
        probs = F.softmax(logits_1d, dim=-1)
        return int(torch.multinomial(probs, num_samples=1))

    @torch.no_grad()
    def _generate_tokens(self, prompt_ids, num_tokens, temperature, top_k, top_p, max_bar_window=2):
        seq = torch.tensor([list(t) for t in prompt_ids], dtype=torch.long, device=self.device)
        
        # Calculate current max bar
        prompt_bar_vals = self.bar_values[seq[:, self.bar_stream_idx]]
        valid = prompt_bar_vals >= 0
        max_bar = int(prompt_bar_vals[valid].max()) if valid.any() else 0
        
        for _ in range(num_tokens):
            context = seq[-self.seq_len:].unsqueeze(0)
            logits, _ = self.model(context)
            
            next_tuple = []
            for s in range(self.num_streams):
                next_logits = logits[s][0, -1].float().clone()
                
                # Apply bar jump cap
                if s == self.bar_stream_idx:
                    threshold = max_bar + max_bar_window
                    too_far = self.bar_values > threshold
                    next_logits[too_far] = -float("inf")
                
                next_id = self._sample_one_stream(next_logits, temperature, top_k, top_p)
                next_tuple.append(next_id)
                
                if s == self.bar_stream_idx:
                    val = int(self.bar_values[next_id])
                    if val > max_bar: max_bar = val
                    
            seq = torch.cat([seq, torch.tensor([next_tuple], dtype=torch.long, device=self.device)], dim=0)
        return seq.tolist()

    def extend_midi(self, input_midi_path, output_midi_path, num_generate=256, temperature=0.8, top_k=0, top_p=1.0):
        import subprocess 
        
        template = Score(str(input_midi_path))
        combined = copy.deepcopy(template)
        
        # Create a blank canvas for the isolated extension
        extension_only = copy.deepcopy(template)
        for tr in extension_only.tracks:
            tr.notes.clear()

        for i, tr in enumerate(template.tracks):
            if len(tr.notes) == 0: continue
            
            single = copy.deepcopy(template)
            single.tracks = [tr]
            tok_seq = self.tokenizer(single)
            
            ids = []
            if isinstance(tok_seq, list):
                for ts in tok_seq: ids.extend(ts.ids)
            else:
                ids = list(tok_seq.ids)
                
            prompt = ids[-256:] 
            if not prompt: continue
            
            # Octuple uses max_bar_window (set to 100 to fix the 2:39 overwrite bug)
            full_ids = self._generate_tokens(prompt, num_generate, temperature, top_k, top_p, max_bar_window=100)
            cont_ids = full_ids[len(prompt):]
            if not cont_ids: continue
            
            new_tok_seq = TokSequence(ids=[list(t) for t in cont_ids])
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
                
        # Shift isolated extension to 0:00
        min_time = min((n.time for tr in extension_only.tracks for n in tr.notes), default=0)
        for tr in extension_only.tracks:
            for n in tr.notes: n.time -= min_time

        # Save files
        base_path_str = str(output_midi_path).replace(".mid", "")
        full_path = f"{base_path_str}_full.mid"
        ext_path = f"{base_path_str}_extension.mid"
        wav_path = f"{base_path_str}.wav"
        
        combined.dump_midi(full_path)
        extension_only.dump_midi(ext_path)
        
        # Render Audio
        soundfont = "/usr/share/sounds/sf2/FluidR3_GM.sf2"
        try:
            subprocess.run(["fluidsynth", "-ni", soundfont, full_path, "-F", wav_path, "-r", "44100"], check=True, stdout=subprocess.DEVNULL)
        except Exception as e:
            print(f"FluidSynth error: {e}")

        return output_midi_path

    def live_extend(self, notes_data, num_generate=64, temperature=0.8, bpm=120):
        
        print(f"\n--- [LIVE JAM] INCOMING REQUEST ---")
        
        # 1. Build the raw score with explicit Metadata
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
        
        # 2. THE ROUND-TRIP TRICK: Force symusic's C++ parser to normalize the grid
        fd, path = tempfile.mkstemp(suffix=".mid")
        os.close(fd)
        raw_score.dump_midi(path)
        
        # Read it back EXACTLY how the offline model does
        score = Score(path)
        os.remove(path)
        
        # 3. Tokenize the perfectly formatted score
        tok_seq = self.tokenizer(score)
        ids = []
        if isinstance(tok_seq, list):
            for ts in tok_seq: ids.extend(ts.ids)
        else:
            ids = list(tok_seq.ids)
            
        prompt = ids[-256:]
        if not prompt: return []
        
        # Generate using the exact same parameters as the offline model (max_bar_window=100)
        full_ids = self._generate_tokens(prompt, num_generate, temperature, top_k=0, top_p=0.95, max_bar_window=100)
        cont_ids = full_ids[len(prompt):]
        if not cont_ids: return []
        
        new_tok_seq = TokSequence(ids=[list(t) for t in cont_ids])
        self.tokenizer.complete_sequence(new_tok_seq)
        
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
                    "time": n_time - min_time, 
                    "duration": getattr(n, 'duration', 120),
                    "velocity": getattr(n, 'velocity', 80)
                })
                    
        return response_notes