"use client";

import { useState, useRef, useEffect } from "react";
import Soundfont from "soundfont-player";
import { useLocalStorage } from "@/hooks/use-local-storage";

// UI Components
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { useToast } from "@/hooks/use-toast";
import { ArchitectureModal } from "@/components/architecture-modal";
import { DebugTerminal } from "@/components/debug-terminal";

// Icons
import { Music, Mic, Square, Activity, Volume2, Play, User, Bot, Download, Trash2, Save, Radio } from "lucide-react";

// --- UTILITIES ---
const msToTicks = (ms: number, bpm: number) => Math.round((ms / 1000) * (bpm / 60) * 480);
const ticksToMs = (ticks: number, bpm: number) => (ticks / 480) * (60 / bpm) * 1000;

interface JamNote {
  pitch: number;
  time: number;
  duration: number;
  velocity: number;
}

interface ChatMessage {
  id: string;
  sender: "user" | "ai";
  notes: JamNote[];
  timestamp: Date;
}

// --- SUB-COMPONENTS ---
interface PianoRollProps {
  notes: JamNote[];
  isPlaying: boolean;
  audioContext: AudioContext | null;
  playbackStartTime: number | null;
  color?: string; 
  bpm: number;
}

/**
 * PianoRoll: Renders a scrolling canvas of MIDI notes.
 */
function PianoRoll({ notes, isPlaying, audioContext, playbackStartTime, color = "#8b5cf6", bpm }: PianoRollProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const PIXELS_PER_SECOND = 80; 

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || notes.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const minTime = Math.min(...notes.map(n => n.time));
    const maxTime = Math.max(...notes.map(n => n.time + n.duration));
    const totalDurationSec = ticksToMs(maxTime - minTime, bpm) / 1000;
    
    const pitches = notes.map(n => n.pitch);
    const minPitch = Math.min(...pitches) - 4; 
    const maxPitch = Math.max(...pitches) + 4; 
    const pitchRange = maxPitch - minPitch;
    const rowHeight = canvas.height / pitchRange;

    let animationId: number;

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      let currentPlayTimeSec = 0;
      if (isPlaying && audioContext && playbackStartTime) {
        currentPlayTimeSec = audioContext.currentTime - playbackStartTime;
        if (currentPlayTimeSec > totalDurationSec + 0.5) currentPlayTimeSec = totalDurationSec + 0.5;
      }

      const playheadX = canvas.width * 0.1; 
      const scrollOffset = playheadX - (currentPlayTimeSec * PIXELS_PER_SECOND);

      ctx.lineWidth = 1;
      for (let i = 0; i <= pitchRange; i++) {
        const y = i * rowHeight;
        ctx.strokeStyle = "rgba(150, 150, 150, 0.1)";
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
      }

      notes.forEach((n) => {
        const startTimeSec = ticksToMs(n.time - minTime, bpm) / 1000;
        const durationSec = ticksToMs(n.duration, bpm) / 1000;
        
        const x = scrollOffset + (startTimeSec * PIXELS_PER_SECOND);
        const y = canvas.height - ((n.pitch - minPitch) * rowHeight) - rowHeight;
        const width = Math.max(durationSec * PIXELS_PER_SECOND, 4); 

        // VISUALS: Add a slight glow to the notes themselves
        ctx.shadowColor = color;
        ctx.shadowBlur = 4;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(x, y, width, rowHeight * 0.8, 4);
        ctx.fill();
        ctx.shadowBlur = 0; // Reset for other elements
      });

      if (isPlaying) {
        ctx.strokeStyle = "rgba(239, 68, 68, 0.8)"; 
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(playheadX, 0);
        ctx.lineTo(playheadX, canvas.height);
        ctx.stroke();
      }

      animationId = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(animationId);
  }, [notes, isPlaying, audioContext, playbackStartTime, color, bpm]); 

  return (
    // VISUALS: Added an inner shadow to make the canvas look embedded
    <canvas ref={canvasRef} width={400} height={100} className="w-full h-24 bg-black/20 rounded-md border border-border/50 shadow-inner" />
  );
}

// --- MAIN COMPONENT ---
export default function LiveExtend() {
  const { toast } = useToast();
  
  // App States
  const [isReady, setIsReady] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isWaitingForAI, setIsWaitingForAI] = useState(false);
  
  // Storage Hooks
  const [messages, setMessages, isHydrated] = useLocalStorage<ChatMessage[]>("amadeus_live_session", []);
  const [savedJams, setSavedJams] = useLocalStorage<any[]>("amadeus_saved_jams", []);

  // Jam States
  const [currentRecording, setCurrentRecording] = useState<JamNote[]>([]);
  const [activeKeys, setActiveKeys] = useState<number[]>([]);
  const [temperature, setTemperature] = useState([0.85]);
  const [numGenerate, setNumGenerate] = useState([64]);
  const [jamModel, setJamModel] = useState("octuple");
  const [topK, setTopK] = useState([0]);
  const [topP, setTopP] = useState([0.95]);

  // Audio Playback States
  const [playingMessageId, setPlayingMessageId] = useState<string | null>(null);
  const [activePlayStartTime, setActivePlayStartTime] = useState<number | null>(null);
  const [logs, setLogs] = useState<string[]>([`[SYS] UI Initialized. Awaiting audio connection.`]);

  // Audio & Hardware Refs
  const audioContext = useRef<AudioContext | null>(null);
  const instrument = useRef<Soundfont.Player | null>(null);
  const recordingStartTime = useRef<number>(0);
  const activeNotesMap = useRef<Map<number, number>>(new Map()); 
  const playbackTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Metronome Engine
  const [bpm, setBpm] = useState([120]);
  const [metronomeOn, setMetronomeOn] = useState(false);
  const bpmRef = useRef(120); 
  const metronomeIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const nextClickTimeRef = useRef<number>(0);
  const beatCountRef = useRef<number>(0);

  // Input Listeners
  const pressedKeysRef = useRef<Set<string>>(new Set());
  const callbacksRef = useRef({ playNote: (p: number) => {}, stopNote: (p: number) => {} });

  // Auto-jam engine: recording starts on the first note played and the take is
  // sent after SILENCE_MS of no input with no keys held. Mirror refs keep the
  // timer callbacks free of stale state (same pattern as bpmRef/callbacksRef).
  const SILENCE_MS = 2500;
  const silenceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isRecordingRef = useRef(false);
  const isWaitingRef = useRef(false);
  const stopAndSendRef = useRef<() => void>(() => {});

  useEffect(() => { bpmRef.current = bpm[0]; }, [bpm]);
  useEffect(() => { isRecordingRef.current = isRecording; }, [isRecording]);
  useEffect(() => { isWaitingRef.current = isWaitingForAI; }, [isWaitingForAI]);
  useEffect(() => () => { if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current); }, []);

  const logSystem = (msg: string) => {
    const timestamp = new Date().toISOString().split('T')[1].slice(0, 12);
    setLogs(prev => [...prev, `${timestamp} - ${msg}`]);
  };

  // --- AUDIO INITIALIZATION ---
  const initializeAudio = async () => {
    try {
      logSystem(`[SYS] Requesting AudioContext access...`);
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      audioContext.current = new AC();
      logSystem(`[SYS] Fetching Soundfont 'acoustic_grand_piano' (~1MB)...`);
      instrument.current = await Soundfont.instrument(audioContext.current, "acoustic_grand_piano");
      setIsReady(true);
      logSystem(`[SYS] WebAudio API active. Hardware clock locked.`);
      toast({ title: "Audio Ready", description: "Piano loaded successfully!" });
    } catch (err) {
      logSystem(`[ERR] Failed to initialize WebAudio API.`);
      toast({ variant: "destructive", title: "Audio Error", description: "Could not load synthesizer." });
    }
  };

  // --- AUTO-JAM SILENCE DETECTION ---
  const checkSilence = () => {
    if (!isRecordingRef.current) return;
    // A held key or an in-flight AI request postpones the send.
    if (activeNotesMap.current.size > 0 || pressedKeysRef.current.size > 0 || isWaitingRef.current) {
      armSilenceTimer(500);
      return;
    }
    stopAndSendRef.current();
  };

  const armSilenceTimer = (ms: number = SILENCE_MS) => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = setTimeout(checkSilence, ms);
  };

  // --- PLAYBACK CONTROLS ---
  const playNote = (pitch: number) => {
    if (!instrument.current || !audioContext.current) return;
    instrument.current.play(pitch.toString(), audioContext.current.currentTime, { duration: 2 });
    setActiveKeys((prev) => [...prev, pitch]);

    // Auto-record: the first note played starts a new take — no Record button.
    // The ref (not state) is read because it updates synchronously — the note
    // that triggers the start must be captured too, before React re-renders.
    let recording = isRecordingRef.current;
    if (!recording) {
      setCurrentRecording([]);
      activeNotesMap.current.clear();
      recordingStartTime.current = Date.now();
      setIsRecording(true);
      isRecordingRef.current = true;
      recording = true;
      logSystem(`[SYS] Auto-record started at ${bpm[0]} BPM.`);
    }

    if (recording) {
      const startTimeMs = Date.now() - recordingStartTime.current;
      activeNotesMap.current.set(pitch, startTimeMs);
    }
    armSilenceTimer();
  };

  const stopNote = (pitch: number) => {
    setActiveKeys((prev) => prev.filter((p) => p !== pitch));
    // Ref, not state: a fast tap can release before React re-renders the
    // auto-started recording, and that first note must not be dropped.
    if (isRecordingRef.current && activeNotesMap.current.has(pitch)) {
      const startTimeMs = activeNotesMap.current.get(pitch)!;
      const durationMs = (Date.now() - recordingStartTime.current) - startTimeMs;
      activeNotesMap.current.delete(pitch);

      setCurrentRecording((prev) => [
        ...prev,
        {
          pitch,
          time: msToTicks(startTimeMs, bpm[0]),
          duration: Math.max(msToTicks(durationMs, bpm[0]), 60),
          velocity: 80,
        },
      ]);
    }
    armSilenceTimer();
  };

  useEffect(() => { callbacksRef.current = { playNote, stopNote }; }, [playNote, stopNote]);

  // --- HARDWARE LISTENERS (QWERTY & MIDI) ---
  useEffect(() => {
    const keyMap: Record<string, number> = {
      'a': 60, 'w': 61, 's': 62, 'e': 63, 'd': 64, 'f': 65, 't': 66,
      'g': 67, 'y': 68, 'h': 69, 'u': 70, 'j': 71, 'k': 72, 'o': 73,
      'l': 74, 'p': 75, ';': 76
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const key = e.key.toLowerCase();
      if (keyMap[key] !== undefined && !pressedKeysRef.current.has(key)) {
        e.preventDefault(); 
        pressedKeysRef.current.add(key);
        callbacksRef.current.playNote(keyMap[key]);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (keyMap[key] !== undefined) {
        pressedKeysRef.current.delete(key);
        callbacksRef.current.stopNote(keyMap[key]);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  useEffect(() => {
    let midiAccess: any = null;
    const handleMIDIMessage = (event: any) => {
      const [command, pitch, velocity] = event.data;
      const isNoteOn = command >= 144 && command <= 159;
      const isNoteOff = command >= 128 && command <= 143;

      if (isNoteOn && velocity > 0) callbacksRef.current.playNote(pitch);
      else if (isNoteOff || (isNoteOn && velocity === 0)) callbacksRef.current.stopNote(pitch);
    };

    const onMIDISuccess = (access: any) => {
      midiAccess = access;
      access.inputs.forEach((input: any) => { input.onmidimessage = handleMIDIMessage; });
      access.onstatechange = (e: any) => {
        if (e.port.type === "input" && e.port.state === "connected") e.port.onmidimessage = handleMIDIMessage;
      };
    };

    if (navigator.requestMIDIAccess) navigator.requestMIDIAccess().then(onMIDISuccess, (err) => console.warn(err));
    return () => { if (midiAccess) midiAccess.inputs.forEach((input: any) => { input.onmidimessage = null; }); };
  }, []);
  
  // --- TIMING ENGINES ---
  useEffect(() => {
    if (!metronomeOn || !audioContext.current) {
      if (metronomeIntervalRef.current) clearInterval(metronomeIntervalRef.current);
      return;
    }

    nextClickTimeRef.current = audioContext.current.currentTime + 0.1;
    beatCountRef.current = 0;

    const scheduler = () => {
      if (!audioContext.current) return;
      while (nextClickTimeRef.current < audioContext.current.currentTime + 0.1) {
        const osc = audioContext.current.createOscillator();
        const gainNode = audioContext.current.createGain();

        osc.type = "square";
        osc.frequency.setValueAtTime(beatCountRef.current === 0 ? 800 : 400, nextClickTimeRef.current);
        gainNode.gain.setValueAtTime(0.1, nextClickTimeRef.current);
        gainNode.gain.exponentialRampToValueAtTime(0.001, nextClickTimeRef.current + 0.05);

        osc.connect(gainNode);
        gainNode.connect(audioContext.current.destination);

        osc.start(nextClickTimeRef.current);
        osc.stop(nextClickTimeRef.current + 0.05);

        const secondsPerBeat = 60.0 / bpmRef.current;
        nextClickTimeRef.current += secondsPerBeat;
        beatCountRef.current = (beatCountRef.current + 1) % 4;
      }
    };
    metronomeIntervalRef.current = setInterval(scheduler, 25);
    return () => { if (metronomeIntervalRef.current) clearInterval(metronomeIntervalRef.current); };
  }, [metronomeOn]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden && instrument.current) {
        instrument.current.stop();
        if (playbackTimeoutRef.current) clearTimeout(playbackTimeoutRef.current);
        setPlayingMessageId(null);
        setActivePlayStartTime(null);
        logSystem(`[SYS] Tab hidden. Audio playback suspended.`);
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  // --- INFERENCE PIPELINE ---
  const stopAndSend = async () => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    setIsRecording(false);
    isRecordingRef.current = false;
    // The metronome intentionally keeps running: in a continuous jam the shared
    // clock must survive across turns.

    if (currentRecording.length === 0) {
      toast({ variant: "destructive", title: "Empty Recording", description: "You need to play some notes before sending!" });
      return;
    }

    logSystem(`[SYS] Captured ${currentRecording.length} notes. Quantizing to JSON payload...`);

    const userMsg: ChatMessage = {
      id: Math.random().toString(36).substring(7),
      sender: "user",
      notes: [...currentRecording],
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setCurrentRecording([]);

    setIsWaitingForAI(true);
    try {
      logSystem(`[NET] Initiating POST /api/jam (tokens: ${numGenerate[0]}, temp: ${temperature[0]})...`);
      
      const response = await fetch("/api/jam", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notes: userMsg.notes,
          num_generate: numGenerate[0],
          temperature: temperature[0],
          top_k: topK[0],
          top_p: topP[0],
          bpm: bpm[0],
          model: jamModel
        }),
      });

      if (!response.ok) throw new Error("AI Jam Failed");

      logSystem(`[AI] Inference complete. Decoding tensor response...`);
      const data = await response.json();
      const aiNotes: JamNote[] = data.notes;

      if (aiNotes && aiNotes.length > 0) {
        logSystem(`[SYS] Network returned ${aiNotes.length} notes. Decompressing TPQ...`);
        const aiMsg: ChatMessage = {
          id: Math.random().toString(36).substring(7),
          sender: "ai",
          notes: aiNotes,
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, aiMsg]);
        // Auto-play the answer so the jam continues without a click.
        playMessage(aiMsg.id, aiNotes);
      } else {
        logSystem(`[ERR] Transformer returned empty sequence.`);
        toast({ title: "AI was silent", description: "The model returned no notes." });
      }
    } catch (err) {
      logSystem(`[ERR] Network failure: ${String(err)}`);
      toast({ variant: "destructive", title: "Error", description: String(err) });
    } finally {
      setIsWaitingForAI(false);
    }
  };

  const playMessage = (msgId: string, notesToPlay: JamNote[]) => {
    if (!isReady || !instrument.current || !audioContext.current) {
      toast({ variant: "destructive", title: "Audio Offline", description: "Please connect instrument!" });
      return;
    }
    if (notesToPlay.length === 0) return;

    if (playingMessageId === msgId) {
      instrument.current.stop();
      if (playbackTimeoutRef.current) clearTimeout(playbackTimeoutRef.current);
      setPlayingMessageId(null);
      setActivePlayStartTime(null);
      return;
    }

    instrument.current.stop();
    if (playbackTimeoutRef.current) clearTimeout(playbackTimeoutRef.current);

    const now = audioContext.current.currentTime + 0.1; 
    setPlayingMessageId(msgId);
    setActivePlayStartTime(now);

    const sortedNotes = [...notesToPlay].sort((a, b) => a.time - b.time);
    const minTime = sortedNotes[0].time;
    let maxDurationSec = 0;

    logSystem(`[SYS] Scheduling ${notesToPlay.length} notes on hardware AudioContext...`);

    sortedNotes.forEach((n) => {
      const startTimeSec = ticksToMs(n.time - minTime, bpm[0]) / 1000;
      const durationSec = ticksToMs(n.duration, bpm[0]) / 1000;
      // Let the piano sample ring out like live input does (live uses a flat 2s):
      // hard-cutting a piano sample at a short tap duration sounds like a synth pluck.
      instrument.current!.play(n.pitch.toString(), now + startTimeSec, {
        duration: Math.max(durationSec, 1.5),
        release: 0.4,
        gain: (n.velocity ?? 80) / 100,
      });
      if (startTimeSec + durationSec > maxDurationSec) maxDurationSec = startTimeSec + durationSec;
    });

    playbackTimeoutRef.current = setTimeout(() => {
      setPlayingMessageId(null);
    }, (maxDurationSec + 0.5) * 1000);
  };

  // Keep the silence timer pointed at the freshest closure — state inside
  // stopAndSend would otherwise be stale when the timer fires.
  useEffect(() => { stopAndSendRef.current = stopAndSend; });

  const playStitchedSession = () => {
    if (!isReady || !instrument.current || !audioContext.current) return;
    if (messages.length === 0) return;

    instrument.current.stop();
    if (playbackTimeoutRef.current) {
      clearTimeout(playbackTimeoutRef.current);
      setPlayingMessageId(null); 
    }

    let now = audioContext.current.currentTime + 0.1; 
    let totalNotes = 0;

    messages.forEach((msg) => {
      if (msg.notes.length === 0) return;
      totalNotes += msg.notes.length;
      const sorted = [...msg.notes].sort((a, b) => a.time - b.time);
      const minTime = sorted[0].time;
      let maxTimeInMsg = 0;

      sorted.forEach((n) => {
        const startTimeSec = ticksToMs(n.time - minTime, bpm[0]) / 1000;
        const durationSec = ticksToMs(n.duration, bpm[0]) / 1000;
        // Same natural ring-out as live input; chunk spacing below still uses
        // the musical durationSec, so timing between chunks is unchanged.
        instrument.current!.play(n.pitch.toString(), now + startTimeSec, {
          duration: Math.max(durationSec, 1.5),
          release: 0.4,
          gain: (n.velocity ?? 80) / 100,
        });

        const noteEndTime = startTimeSec + durationSec;
        if (noteEndTime > maxTimeInMsg) maxTimeInMsg = noteEndTime;
      });
      now += maxTimeInMsg + 0.2; 
    });

    logSystem(`[SYS] Math-stitching ${messages.length} chunks. Scheduled ${totalNotes} notes linearly.`);
    toast({ title: "Playing Session", description: "Stitching back-to-back..." });
  };

  const exportNotesToMIDI = async (notes: JamNote[], filename: string) => {
    try {
      logSystem(`[NET] Fetching /api/jam/export for binary serialization...`);
      const response = await fetch("/api/jam/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes, num_generate: 64, temperature: 0.5 }), 
      });
      if (!response.ok) throw new Error("Failed to export MIDI");

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      logSystem(`[SYS] Downloaded compiled payload: ${filename}`);
      toast({ title: "Exported", description: `${filename} downloaded successfully.` });
    } catch (err) {
      logSystem(`[ERR] Serialization failed: ${String(err)}`);
      toast({ variant: "destructive", title: "Export Error", description: String(err) });
    }
  };

  const downloadMessage = (msg: ChatMessage) => { exportNotesToMIDI(msg.notes, `jam_${msg.sender}_${msg.id.substring(0, 4)}.mid`); };

  const downloadSession = () => {
    if (messages.length === 0) return;
    let combinedNotes: JamNote[] = [];
    let currentTickOffset = 0; 

    messages.forEach((msg) => {
      if (msg.notes.length === 0) return;
      const sorted = [...msg.notes].sort((a, b) => a.time - b.time);
      const minTime = sorted[0].time;
      let maxTimeInMsgTicks = 0;

      sorted.forEach((n) => {
        const shiftedTime = (n.time - minTime) + currentTickOffset;
        combinedNotes.push({ ...n, time: shiftedTime });
        const noteEndTimeTicks = shiftedTime + n.duration;
        if (noteEndTimeTicks > maxTimeInMsgTicks) maxTimeInMsgTicks = noteEndTimeTicks;
      });
      currentTickOffset = maxTimeInMsgTicks + 480; 
    });

    logSystem(`[SYS] Memory timeline stitched. Total ticks: ${currentTickOffset}`);
    exportNotesToMIDI(combinedNotes, "jam_full_session.mid");
  };

  const keyboardLayout = [
    { pitch: 60, note: "C4", isBlack: false, trigger: "A" }, { pitch: 61, note: "C#4", isBlack: true, trigger: "W" },
    { pitch: 62, note: "D4", isBlack: false, trigger: "S" }, { pitch: 63, note: "D#4", isBlack: true, trigger: "E" },
    { pitch: 64, note: "E4", isBlack: false, trigger: "D" }, { pitch: 65, note: "F4", isBlack: false, trigger: "F" },
    { pitch: 66, note: "F#4", isBlack: true, trigger: "T" }, { pitch: 67, note: "G4", isBlack: false, trigger: "G" },
    { pitch: 68, note: "G#4", isBlack: true, trigger: "Y" }, { pitch: 69, note: "A4", isBlack: false, trigger: "H" },
    { pitch: 70, note: "A#4", isBlack: true, trigger: "U" }, { pitch: 71, note: "B4", isBlack: false, trigger: "J" },
    { pitch: 72, note: "C5", isBlack: false, trigger: "K" }, { pitch: 73, note: "C#5", isBlack: true, trigger: "O" },
    { pitch: 74, note: "D5", isBlack: false, trigger: "L" }, { pitch: 75, note: "D#5", isBlack: true, trigger: "P" },
    { pitch: 76, note: "E5", isBlack: false, trigger: ";" }
  ];

  // --- RENDER ---
  return (
    <div className="w-full max-w-4xl mx-auto py-8 flex gap-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      
      {/* LEFT COLUMN: Input Engine & Controls */}
      <div className="flex-1 flex flex-col gap-6">
        
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              Amadeus Live Studio <Radio className="w-5 h-5 text-primary" />
            </h2>
            <p className="text-sm text-muted-foreground">Real-time neural call-and-response engine</p>
          </div>
          <ArchitectureModal />
        </div>

        {/* Main Input Card */}
        {/* VISUALS: Deep gradient, shadow, and a subtle glowing border */}
        <Card className="bg-gradient-to-br from-card to-background/50 border-primary/20 shadow-lg shadow-primary/5">
          <CardHeader className="text-center pb-4 border-b border-border/50 bg-secondary/5 rounded-t-xl">
            <CardTitle className="text-xl font-bold flex items-center justify-center gap-2">
              <Activity className="w-5 h-5 text-primary" /> Input Engine
            </CardTitle>
          </CardHeader>
          
          <CardContent className="space-y-6 pt-6">
            {!isReady ? (
              <div className="flex flex-col items-center justify-center py-12 gap-6 text-muted-foreground">
                <Volume2 className="w-16 h-16 opacity-30" />
                {/* VISUALS: Pulse animation to draw the user's eye to connect audio */}
                <div className="relative">
                  <div className="absolute inset-0 bg-primary/40 rounded-md blur animate-pulse" />
                  <Button onClick={initializeAudio} size="lg" className="relative gap-2 shadow-md hover:shadow-primary/40 transition-all">
                    <Music className="w-5 h-5" /> Connect Instrument
                  </Button>
                </div>
              </div>
            ) : (
              <>
                {/* Visual Piano Keyboard */}
                {/* VISUALS: Improved key styling with realistic 3D gradients and inner shadows for pressed states */}
               <div className="relative h-48 bg-black/40 rounded-xl border-4 border-primary/40 overflow-hidden flex justify-center p-4 select-none shadow-inner">
                  {keyboardLayout.map((k) => (
                    <div
                      key={k.pitch}
                      onMouseDown={() => playNote(k.pitch)}
                      onMouseUp={() => stopNote(k.pitch)}
                      onMouseLeave={() => stopNote(k.pitch)}
                      className={`relative border border-black/80 rounded-b-md cursor-pointer transition-all flex items-end justify-center pb-2 ${
                        k.isBlack 
                          ? "bg-gradient-to-b from-zinc-800 to-black w-8 h-24 -mx-4 z-10 text-white/40 shadow-md" 
                          : "bg-gradient-to-b from-white to-gray-200 w-12 h-40 z-0 text-gray-400 shadow-sm"
                      } ${activeKeys.includes(k.pitch) 
                          ? (k.isBlack ? "bg-primary text-white ring-2 ring-primary inset-shadow" : "bg-primary/30 text-primary ring-2 ring-primary inset-shadow") 
                          : ""
                      }`}
                    >
                      <span className="text-[10px] font-mono font-bold pointer-events-none select-none">
                        {k.trigger}
                      </span>
                    </div>
                  ))}
                </div>
                
                {/* Parameters Grid */}
                <div className="grid grid-cols-2 gap-6 p-5 bg-secondary/10 rounded-lg border border-border/50 shadow-inner">
                  <div className="space-y-3 col-span-2 group">
                    <label className="text-sm font-medium group-hover:text-primary transition-colors">AI Jam Partner</label>
                    <select
                      value={jamModel}
                      onChange={(e) => setJamModel(e.target.value)}
                      className="flex h-10 w-full rounded-md border border-input bg-background/50 backdrop-blur-sm px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    >
                      <option value="octuple">Multi-Track Model (Octuple)</option>
                      <option value="remi">Standard Model (REMI)</option>
                      <option value="remi_classical">Classical Model (REMI Fine-Tune)</option>
                      <option value="remi_movies">Movie Score Model (REMI Fine-Tune)</option>
                    </select>
                  </div>

                  <div className="space-y-3 group">
                    <div className="flex items-center justify-between text-sm">
                      <label className="font-medium group-hover:text-primary transition-colors">Temperature</label>
                      <span className="font-mono text-muted-foreground bg-primary/10 px-2 py-0.5 rounded">{temperature[0]}</span>
                    </div>
                    <Slider value={temperature} onValueChange={setTemperature} min={0.1} max={1.5} step={0.1} />
                  </div>
                  
                  <div className="space-y-3 group">
                    <div className="flex items-center justify-between text-sm">
                      <label className="font-medium group-hover:text-primary transition-colors">Tokens</label>
                      <span className="font-mono text-muted-foreground bg-primary/10 px-2 py-0.5 rounded">{numGenerate[0]}</span>
                    </div>
                    <Slider value={numGenerate} onValueChange={setNumGenerate} min={16} max={128} step={16} />
                  </div>
                  
                  <div className="space-y-3 group">
                    <div className="flex items-center justify-between text-sm">
                      <label className="font-medium group-hover:text-primary transition-colors">Top-K</label>
                      <span className="font-mono text-muted-foreground bg-primary/10 px-2 py-0.5 rounded">{topK[0]}</span>
                    </div>
                    <Slider value={topK} onValueChange={setTopK} min={0} max={100} step={1} />
                  </div>
                  
                  <div className="space-y-3 group">
                    <div className="flex items-center justify-between text-sm">
                      <label className="font-medium group-hover:text-primary transition-colors">Top-P</label>
                      <span className="font-mono text-muted-foreground bg-primary/10 px-2 py-0.5 rounded">{topP[0]}</span>
                    </div>
                    <Slider value={topP} onValueChange={setTopP} min={0.1} max={1.0} step={0.05} />
                  </div>
                  
                  {/* Metronome Controls */}
                  <div className="space-y-3 col-span-2 pt-2 border-t border-border/50">
                    <div className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-4">
                        <label className="font-medium">Tempo (BPM)</label>
                        <Button 
                          variant={metronomeOn ? "default" : "outline"} 
                          size="sm" 
                          className="h-7 text-xs font-semibold tracking-wider"
                          onClick={() => setMetronomeOn(!metronomeOn)}
                        >
                          Metronome {metronomeOn ? "ON" : "OFF"}
                        </Button>
                      </div>
                      <span className="font-mono font-bold text-primary bg-primary/10 px-2 py-0.5 rounded">{bpm[0]}</span>
                    </div>
                    <Slider value={bpm} onValueChange={setBpm} min={60} max={200} step={1} className="py-2" />
                  </div>
                </div>

                {/* Auto-Jam Status Strip: recording starts when the user plays
                    and sends itself after a short pause — no required clicks. */}
                <div className="flex items-center justify-between pt-2">
                  <div className="flex items-center gap-2">
                    {!isRecording && !isWaitingForAI && (
                      <div className="flex items-center gap-2 text-muted-foreground text-sm font-semibold bg-secondary/30 px-3 py-1.5 rounded-full">
                        <Mic className="w-4 h-4" /> Listening — just start playing
                      </div>
                    )}
                    {isRecording && (
                      <>
                        <div className="flex items-center gap-2 text-red-500 text-sm font-semibold animate-pulse bg-red-500/10 px-3 py-1.5 rounded-full">
                          <Mic className="w-4 h-4" /> Recording — pause to send
                        </div>
                        <Button size="sm" onClick={stopAndSend} className="gap-2 bg-primary hover:bg-primary/90 shadow-md shadow-primary/30 transition-all">
                          <Square className="w-3 h-3 fill-current" /> Send now
                        </Button>
                      </>
                    )}
                  </div>

                  {isWaitingForAI && (
                    <div className="flex items-center gap-2 text-primary text-sm font-semibold animate-pulse bg-primary/10 px-3 py-1.5 rounded-full">
                      <Activity className="w-4 h-4" /> Neural inference running...
                    </div>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Debug Terminal */}
        <DebugTerminal logs={logs} />
      </div>

      {/* RIGHT COLUMN: Chat History Timeline */}
      <div className="w-[400px] flex flex-col h-[750px]">
        <Card className="flex-1 flex flex-col bg-gradient-to-br from-card to-background/50 shadow-lg border-border/50 overflow-hidden">
          <CardHeader className="bg-secondary/10 border-b border-border/50 py-4 shadow-sm z-10">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2">
                <Radio className="w-4 h-4 text-primary" /> Session Timeline
              </CardTitle>
              
              {isHydrated && (
                <div className="flex gap-1.5">
                  <Button 
                    onClick={() => {
                      if (confirm("Save this session to your Dashboard history and start a new one?")) {
                        const newArchivedJam = {
                          id: `live-${Date.now()}`, 
                          type: "live_jam",
                          inputFilename: `Live Jam (${messages.length} turns)`,
                          status: "completed",
                          createdAt: new Date(),
                          isLocal: true,
                          messages: messages 
                        };
                        setSavedJams((prev) => [...(prev || []), newArchivedJam]);
                        setMessages([]);
                        logSystem(`[SYS] Memory cleared and saved to SQLite dashboard view.`);
                        toast({ title: "Session Saved", description: "Archived to your Dashboard." });
                      }
                    }} 
                    disabled={messages.length === 0}
                    variant="ghost" 
                    size="icon" 
                    className="text-primary hover:bg-primary/10 hover:text-primary h-8 w-8"
                    title="Save & Close Session"
                  >
                    <Save className="w-4 h-4" />
                  </Button>

                  <Button 
                    onClick={() => {
                      if (confirm("Are you sure you want to clear this entire session? It will NOT be saved.")) {
                        setMessages([]);
                        logSystem(`[SYS] Temporary timeline draft purged.`);
                      }
                    }} 
                    disabled={messages.length === 0}
                    variant="ghost" 
                    size="icon" 
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive h-8 w-8"
                    title="Delete Session"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>

                  <Button onClick={downloadSession} disabled={messages.length === 0} variant="outline" size="sm" className="gap-2 h-8">
                    <Download className="w-3.5 h-3.5" /> Full
                  </Button>
                  <Button onClick={playStitchedSession} disabled={messages.length === 0} variant="default" size="sm" className="gap-2 h-8 shadow-sm">
                    <Play className="w-3.5 h-3.5" /> Play All
                  </Button>
                </div>
              )}
            </div>
          </CardHeader>
          
          <CardContent className="flex-1 overflow-y-auto p-4 space-y-6 custom-scrollbar">
            
            {messages.length === 0 && (
              <div className="text-center text-muted-foreground flex flex-col items-center justify-center h-full gap-4 opacity-60">
                <Music className="w-12 h-12" />
                <p className="italic">Hit record, play a melody, and send it to start the jam.</p>
              </div>
            )}

            {messages.map((msg) => (
              <div key={msg.id} className={`flex flex-col ${msg.sender === "user" ? "items-end" : "items-start"}`}>
                
                {/* Avatar Row */}
                <div className="flex items-center gap-2 mb-1.5 px-2">
                  {msg.sender === "user" 
                    ? <User className="w-3.5 h-3.5 opacity-50" /> 
                    : <Bot className="w-3.5 h-3.5 opacity-80 text-primary" />
                  }
                  <span className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground">
                    {msg.sender === "user" ? "You" : "Amadeus AI"}
                  </span>
                </div>
                
                {/* Message Bubble */}
                {/* VISUALS: Added sleek gradients to chat bubbles and a glowing ring when that specific message is playing */}
                <div className={`p-3 rounded-xl w-full max-w-[92%] shadow-md transition-all duration-300 ${
                  playingMessageId === msg.id ? "ring-2 ring-primary/60 shadow-[0_0_20px_rgba(139,92,246,0.3)] scale-[1.01]" : ""
                } ${
                  msg.sender === "user" 
                    ? "bg-gradient-to-br from-primary to-primary/80 text-primary-foreground rounded-tr-none" 
                    : "bg-secondary/40 border border-border/50 rounded-tl-none backdrop-blur-sm"
                }`}>
                  
                  <div className="mb-3">
                     <PianoRoll 
                       notes={msg.notes} 
                       isPlaying={playingMessageId === msg.id}
                       audioContext={audioContext.current}
                       playbackStartTime={activePlayStartTime}
                       color={msg.sender === "user" ? "#ffffff" : "#a78bfa"}
                       bpm={bpm[0]} 
                     />
                  </div>

                  <div className="flex items-center justify-between gap-6 px-1">
                    <span className="text-xs font-mono opacity-80">{msg.notes.length} notes</span>
                    <div className="flex gap-1.5">
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        className={`h-7 w-7 transition-colors ${msg.sender === "user" ? "hover:bg-black/20 text-white" : "hover:bg-primary/20 hover:text-primary"}`}
                        onClick={() => downloadMessage(msg)}
                        title="Download this part"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </Button>
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        className={`h-7 w-7 transition-colors ${
                          playingMessageId === msg.id 
                            ? (msg.sender === "user" ? "bg-white/20 text-white" : "bg-primary/20 text-primary") 
                            : (msg.sender === "user" ? "hover:bg-black/20 text-white" : "hover:bg-primary/20 hover:text-primary")
                        }`}
                        onClick={() => playMessage(msg.id, msg.notes)}
                      >
                        {playingMessageId === msg.id ? <Square className="w-3.5 h-3.5 fill-current" /> : <Play className="w-3.5 h-3.5 fill-current" />}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
            
          </CardContent>
        </Card>
      </div>
    </div>
  );
}