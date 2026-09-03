import { useState, useRef, useCallback, useEffect } from "react";
import Soundfont from "soundfont-player";
import { Midi } from "@tonejs/midi";
import { Play, Square } from "lucide-react";
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
  const acRef = useRef<AudioContext | null>(null);
  const instrumentRef = useRef<Soundfont.Player | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number>(0);

  const clearAll = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (instrumentRef.current) instrumentRef.current.stop();
  }, []);

  useEffect(() => () => clearAll(), [clearAll]);

  const play = useCallback(async () => {
    if (state === "playing") return;
    setState("loading");
    try {
      // Same acoustic piano soundfont the live jam page uses — playback should
      // sound like a piano, not an oscillator synth.
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      if (!acRef.current) acRef.current = new AC();
      await acRef.current.resume();
      if (!instrumentRef.current) {
        instrumentRef.current = await Soundfont.instrument(acRef.current, "acoustic_grand_piano");
      }

      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch MIDI");
      const buf = await res.arrayBuffer();
      const midi = new Midi(buf);

      clearAll();

      // Skip percussion tracks: a piano playing a drum pattern is noise.
      const notes = midi.tracks
        .filter((t) => !t.instrument.percussion && t.notes.length > 0)
        .flatMap((t) => t.notes);
      if (notes.length === 0) throw new Error("No playable notes");

      const totalDur = Math.max(...notes.map((n) => n.time + n.duration), 1);
      setDuration(totalDur);

      const t0 = acRef.current.currentTime + 0.1;
      notes.forEach((n) => {
        // Duration floor + release keep short notes sounding like piano taps
        // instead of hard-cut synth blips (same treatment as the jam page).
        instrumentRef.current!.play(n.name, t0 + n.time, {
          duration: Math.max(n.duration, 1.5),
          release: 0.4,
          gain: Math.max(n.velocity, 0.2),
        });
      });

      startedAtRef.current = Date.now();
      setState("playing");

      intervalRef.current = setInterval(() => {
        const elapsed = (Date.now() - startedAtRef.current) / 1000;
        const p = Math.min(elapsed / totalDur, 1);
        setProgress(p);
        if (p >= 1) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          setState("done");
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
