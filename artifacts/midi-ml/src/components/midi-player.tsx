import { useState, useRef, useCallback, useEffect } from "react";
import * as Tone from "tone";
import { Midi } from "@tonejs/midi";
import { Play, Pause, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface MidiPlayerProps {
  url: string;
  label?: string;
  compact?: boolean;
}

type PlayerState = "idle" | "loading" | "playing" | "paused" | "done" | "error";

export function MidiPlayer({ url, label, compact = false }: MidiPlayerProps) {
  const [state, setState] = useState<PlayerState>("idle");
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const partsRef = useRef<Tone.Part[]>([]);
  const synthRef = useRef<Tone.PolySynth | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number>(0);

  const clearAll = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    partsRef.current.forEach((p) => { p.stop(); p.dispose(); });
    partsRef.current = [];
    if (synthRef.current) { synthRef.current.releaseAll(); synthRef.current.dispose(); synthRef.current = null; }
    Tone.getTransport().stop();
    Tone.getTransport().cancel();
  }, []);

  useEffect(() => () => clearAll(), [clearAll]);

  const play = useCallback(async () => {
    if (state === "playing") return;
    setState("loading");
    try {
      await Tone.start();
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch MIDI");
      const buf = await res.arrayBuffer();
      const midi = new Midi(buf);

      clearAll();

      const synth = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: "triangle" },
        envelope: { attack: 0.02, decay: 0.1, sustain: 0.5, release: 0.8 },
        volume: -8,
      }).toDestination();
      synthRef.current = synth;

      const totalDur = Math.max(...midi.tracks.map((t) => (t.notes.at(-1)?.time ?? 0) + (t.notes.at(-1)?.duration ?? 0)), 1);
      setDuration(totalDur);

      const parts: Tone.Part[] = midi.tracks
        .filter((t) => t.notes.length > 0)
        .map((track) => {
          const part = new Tone.Part((time, note: { name: string; duration: number; velocity: number }) => {
            synth.triggerAttackRelease(note.name, note.duration, time, note.velocity);
          }, track.notes.map((n) => ({ time: n.time, name: n.name, duration: n.duration, velocity: n.velocity })));
          part.start(0);
          return part;
        });
      partsRef.current = parts;

      Tone.getTransport().stop();
      Tone.getTransport().cancel();
      Tone.getTransport().position = 0;

      startedAtRef.current = Date.now();
      Tone.getTransport().start();

      setState("playing");

      intervalRef.current = setInterval(() => {
        const elapsed = (Date.now() - startedAtRef.current) / 1000;
        const p = Math.min(elapsed / totalDur, 1);
        setProgress(p);
        if (p >= 1) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          setState("done");
          clearAll();
          setProgress(0);
        }
      }, 100);
    } catch {
      setState("error");
    }
  }, [state, url, clearAll]);

  const stop = useCallback(() => {
    clearAll();
    setState("idle");
    setProgress(0);
  }, [clearAll]);

  const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const elapsed = progress * duration;

  if (compact) {
    return (
      <div className="flex items-center gap-2" data-testid="midi-player">
        <button
          onClick={state === "playing" ? stop : play}
          disabled={state === "loading" || state === "error"}
          className={cn(
            "w-8 h-8 rounded-full flex items-center justify-center transition-colors shrink-0",
            state === "playing" ? "bg-primary text-primary-foreground" : "bg-secondary hover:bg-primary/20 text-foreground",
            (state === "loading" || state === "error") && "opacity-50 cursor-not-allowed"
          )}
        >
          {state === "loading" ? (
            <div className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
          ) : state === "playing" ? (
            <Square className="w-3 h-3 fill-current" />
          ) : (
            <Play className="w-3 h-3 fill-current ml-0.5" />
          )}
        </button>

        <div className="flex-1 min-w-0">
          {label && <p className="text-xs text-muted-foreground truncate">{label}</p>}
          <div className="h-1 bg-secondary rounded-full overflow-hidden mt-1">
            <div
              className="h-full bg-primary rounded-full transition-all"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
        </div>

        {duration > 0 && (
          <span className="text-xs font-mono text-muted-foreground shrink-0">
            {fmtTime(elapsed)}/{fmtTime(duration)}
          </span>
        )}
        {state === "error" && <span className="text-xs text-red-500">Error</span>}
      </div>
    );
  }

  return (
    <div className="space-y-3 p-4 rounded-lg bg-secondary/30 border border-border" data-testid="midi-player">
      {label && <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</p>}

      <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
        <div
          className="h-full bg-primary rounded-full transition-all duration-100"
          style={{ width: `${progress * 100}%` }}
        />
      </div>

      <div className="flex items-center gap-3">
        <Button
          size="sm"
          variant={state === "playing" ? "default" : "secondary"}
          onClick={state === "playing" ? stop : play}
          disabled={state === "loading" || state === "error"}
          className="gap-2"
          data-testid="button-play"
        >
          {state === "loading" ? (
            <div className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
          ) : state === "playing" ? (
            <><Square className="w-3 h-3 fill-current" /> Stop</>
          ) : (
            <><Play className="w-3 h-3 fill-current" /> {state === "done" ? "Replay" : "Play"}</>
          )}
        </Button>

        {duration > 0 && (
          <span className="text-sm font-mono text-muted-foreground">
            {fmtTime(elapsed)} / {fmtTime(duration)}
          </span>
        )}
        {state === "error" && <span className="text-sm text-red-500">Could not load audio</span>}
      </div>
    </div>
  );
}
