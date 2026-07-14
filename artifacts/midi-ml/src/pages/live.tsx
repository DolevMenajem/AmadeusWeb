"use client";

import { useState, useRef, useEffect } from "react";
import Soundfont from "soundfont-player";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Music, Mic, Square, Activity, Volume2, Play, User, Bot, Download, Trash2, Save } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Slider } from "@/components/ui/slider";
import { useLocalStorage } from "@/hooks/use-local-storage";

// IMPORT OUR NEW COMPONENTS
import { ArchitectureModal } from "@/components/architecture-modal";
import { DebugTerminal } from "@/components/debug-terminal";

const MS_TO_TICKS = 0.96; 
const TICKS_TO_MS = 1.0416;

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

interface PianoRollProps {
  notes: JamNote[];
  isPlaying: boolean;
  audioContext: AudioContext | null;
  playbackStartTime: number | null;
  color?: string; 
}

function PianoRoll({ notes, isPlaying, audioContext, playbackStartTime, color = "#3b82f6" }: PianoRollProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const TICKS_TO_MS = 1.0416;
  const PIXELS_PER_SECOND = 80; 

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || notes.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const minTime = Math.min(...notes.map(n => n.time));
    const maxTime = Math.max(...notes.map(n => n.time + n.duration));
    const totalDurationSec = ((maxTime - minTime) * TICKS_TO_MS) / 1000;
    
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
        const startTimeSec = ((n.time - minTime) * TICKS_TO_MS) / 1000;
        const durationSec = (n.duration * TICKS_TO_MS) / 1000;
        
        const x = scrollOffset + (startTimeSec * PIXELS_PER_SECOND);
        const y = canvas.height - ((n.pitch - minPitch) * rowHeight) - rowHeight;
        const width = Math.max(durationSec * PIXELS_PER_SECOND, 4); 

        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(x, y, width, rowHeight * 0.8, 4);
        ctx.fill();
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
  }, [notes, isPlaying, audioContext, playbackStartTime, color]);

  return (
    <canvas ref={canvasRef} width={400} height={100} className="w-full h-24 bg-black/5 rounded-md border border-border/50" />
  );
}

export default function LiveExtend() {
  const { toast } = useToast();
  const [isReady, setIsReady] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isWaitingForAI, setIsWaitingForAI] = useState(false);
  
  const [messages, setMessages, isHydrated] = useLocalStorage<ChatMessage[]>("amadeus_live_session", []);
  const [savedJams, setSavedJams] = useLocalStorage<any[]>("amadeus_saved_jams", []);

  const [currentRecording, setCurrentRecording] = useState<JamNote[]>([]);
  const [activeKeys, setActiveKeys] = useState<number[]>([]);
  
  const [temperature, setTemperature] = useState([0.5]); 
  const [numGenerate, setNumGenerate] = useState([64]);  

  const [playingMessageId, setPlayingMessageId] = useState<string | null>(null);
  const [activePlayStartTime, setActivePlayStartTime] = useState<number | null>(null);

  // NEW: Terminal State
  const [logs, setLogs] = useState<string[]>([
    `[SYS] UI Initialized. Awaiting audio connection.`
  ]);

  const audioContext = useRef<AudioContext | null>(null);
  const instrument = useRef<Soundfont.Player | null>(null);
  const recordingStartTime = useRef<number>(0);
  const activeNotesMap = useRef<Map<number, number>>(new Map()); 
  const playbackTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Terminal Logger Helper
  const logSystem = (msg: string) => {
    const timestamp = new Date().toISOString().split('T')[1].slice(0, 12);
    setLogs(prev => [...prev, `${timestamp} - ${msg}`]);
  };

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

  const playNote = (pitch: number) => {
    if (!instrument.current || !audioContext.current) return;
    instrument.current.play(pitch.toString(), audioContext.current.currentTime, { duration: 2 });
    setActiveKeys((prev) => [...prev, pitch]);

    if (isRecording) {
      const startTimeMs = Date.now() - recordingStartTime.current;
      activeNotesMap.current.set(pitch, startTimeMs);
    }
  };

  const stopNote = (pitch: number) => {
    setActiveKeys((prev) => prev.filter((p) => p !== pitch));
    
    if (isRecording && activeNotesMap.current.has(pitch)) {
      const startTimeMs = activeNotesMap.current.get(pitch)!;
      const durationMs = (Date.now() - recordingStartTime.current) - startTimeMs;
      activeNotesMap.current.delete(pitch);

      setCurrentRecording((prev) => [
        ...prev,
        {
          pitch,
          time: Math.round(startTimeMs * MS_TO_TICKS),
          duration: Math.max(Math.round(durationMs * MS_TO_TICKS), 120), 
          velocity: 80, 
        },
      ]);
    }
  };

  const startRecording = () => {
    setCurrentRecording([]);
    activeNotesMap.current.clear();
    recordingStartTime.current = Date.now();
    setIsRecording(true);
    logSystem(`[SYS] Recording started. Tracking raw millisecond events...`);
  };

  const stopAndSend = async () => {
    setIsRecording(false);
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
      logSystem(`[AI] Symusic parser establishing 120BPM temporal grid...`);
      
      const response = await fetch("/api/jam", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          notes: userMsg.notes, 
          num_generate: numGenerate[0], 
          temperature: temperature[0] 
        }),
      });

      if (!response.ok) throw new Error("AI Jam Failed");

      logSystem(`[AI] Inference complete. Decoding tensor response...`);
      const data = await response.json();
      const aiNotes: JamNote[] = data.notes;

      if (aiNotes && aiNotes.length > 0) {
        logSystem(`[SYS] Network returned ${aiNotes.length} notes. Decompressing TPQ (8 -> 480)...`);
        const aiMsg: ChatMessage = {
          id: Math.random().toString(36).substring(7),
          sender: "ai",
          notes: aiNotes,
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, aiMsg]);
        logSystem(`[SYS] Hydrating React visualizer...`);
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
      toast({ variant: "destructive", title: "Audio Offline", description: "Please click 'Connect Instrument' on the left before playing audio!" });
      return;
    }
    if (notesToPlay.length === 0) return;

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
      const startTimeSec = ((n.time - minTime) * TICKS_TO_MS) / 1000;
      const durationSec = (n.duration * TICKS_TO_MS) / 1000;
      instrument.current!.play(n.pitch.toString(), now + startTimeSec, { duration: durationSec });
      if (startTimeSec + durationSec > maxDurationSec) maxDurationSec = startTimeSec + durationSec;
    });

    playbackTimeoutRef.current = setTimeout(() => {
      setPlayingMessageId(null);
    }, (maxDurationSec + 0.5) * 1000);
  };

  const playStitchedSession = () => {
    if (!isReady || !instrument.current || !audioContext.current) {
      toast({ variant: "destructive", title: "Audio Offline", description: "Please click 'Connect Instrument' on the left before playing audio!" });
      return;
    }
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
        const startTimeSec = ((n.time - minTime) * TICKS_TO_MS) / 1000;
        const durationSec = (n.duration * TICKS_TO_MS) / 1000;
        instrument.current!.play(n.pitch.toString(), now + startTimeSec, { duration: durationSec });
        
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

  const downloadMessage = (msg: ChatMessage) => {
    const safeId = msg.id.substring(0, 4);
    exportNotesToMIDI(msg.notes, `jam_${msg.sender}_${safeId}.mid`);
  };

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
        if (noteEndTimeTicks > maxTimeInMsgTicks) {
          maxTimeInMsgTicks = noteEndTimeTicks;
        }
      });
      currentTickOffset = maxTimeInMsgTicks + 480; 
    });

    logSystem(`[SYS] Memory timeline stitched. Total ticks: ${currentTickOffset}`);
    exportNotesToMIDI(combinedNotes, "jam_full_session.mid");
  };

  const keyboardLayout = [
    { pitch: 60, note: "C4", isBlack: false }, { pitch: 61, note: "C#4", isBlack: true },
    { pitch: 62, note: "D4", isBlack: false }, { pitch: 63, note: "D#4", isBlack: true },
    { pitch: 64, note: "E4", isBlack: false }, { pitch: 65, note: "F4", isBlack: false },
    { pitch: 66, note: "F#4", isBlack: true }, { pitch: 67, note: "G4", isBlack: false },
    { pitch: 68, note: "G#4", isBlack: true }, { pitch: 69, note: "A4", isBlack: false },
    { pitch: 70, note: "A#4", isBlack: true }, { pitch: 71, note: "B4", isBlack: false },
    { pitch: 72, note: "C5", isBlack: false }, { pitch: 73, note: "C#5", isBlack: true },
    { pitch: 74, note: "D5", isBlack: false }, { pitch: 75, note: "D#5", isBlack: true },
    { pitch: 76, note: "E5", isBlack: false }
  ];

  return (
    <div className="w-full max-w-4xl mx-auto py-8 flex gap-6">
      
      {/* Left Column: The Piano, Controls, and Terminal */}
      <div className="flex-1 flex flex-col gap-6">
        
        {/* NEW: Title & Architecture Modal Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold tracking-tight">Amadeus Live Studio</h2>
            <p className="text-sm text-muted-foreground">Neural call-and-response engine</p>
          </div>
          <ArchitectureModal />
        </div>

        <Card className="shadow-lg border-primary/20">
          <CardHeader className="text-center pb-4">
            <CardTitle className="text-xl font-bold flex items-center justify-center gap-2">
              <Activity className="w-5 h-5 text-primary" /> Input Engine
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {!isReady ? (
              <div className="flex flex-col items-center justify-center py-12 gap-4 text-muted-foreground">
                <Volume2 className="w-12 h-12 opacity-50" />
                <Button onClick={initializeAudio} size="lg" className="gap-2">
                  <Music className="w-5 h-5" /> Connect Instrument
                </Button>
              </div>
            ) : (
              <>
                <div className="relative h-48 bg-secondary/20 rounded-xl border-4 border-primary/50 overflow-hidden flex justify-center p-4 select-none">
                  {keyboardLayout.map((k) => (
                    <div
                      key={k.pitch}
                      onMouseDown={() => playNote(k.pitch)}
                      onMouseUp={() => stopNote(k.pitch)}
                      onMouseLeave={() => stopNote(k.pitch)}
                      className={`relative border border-foreground/20 rounded-b-md cursor-pointer transition-colors ${
                        k.isBlack ? "bg-zinc-900 w-8 h-24 -mx-4 z-10" : "bg-white w-12 h-40 z-0"
                      } ${activeKeys.includes(k.pitch) ? (k.isBlack ? "bg-primary/80" : "bg-primary/20") : ""}`}
                    />
                  ))}
                </div>
                
                <div className="grid grid-cols-2 gap-6 p-4 bg-secondary/5 rounded-lg border border-border/50">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between text-sm">
                      <label className="font-medium">Temperature</label>
                      <span className="font-mono text-muted-foreground">{temperature[0]}</span>
                    </div>
                    <Slider value={temperature} onValueChange={setTemperature} min={0.1} max={1.5} step={0.1} />
                  </div>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between text-sm">
                      <label className="font-medium">Tokens (Notes)</label>
                      <span className="font-mono text-muted-foreground">{numGenerate[0]}</span>
                    </div>
                    <Slider value={numGenerate} onValueChange={setNumGenerate} min={16} max={128} step={16} />
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <div className="flex gap-2">
                    {!isRecording ? (
                      <Button onClick={startRecording} className="w-32 gap-2" variant="default">
                        <Mic className="w-4 h-4" /> Record
                      </Button>
                    ) : (
                      <Button onClick={stopAndSend} className="w-32 gap-2" variant="destructive">
                        <Square className="w-4 h-4" /> Stop & Send
                      </Button>
                    )}
                  </div>
                  
                  {isWaitingForAI && (
                    <div className="flex items-center gap-2 text-primary text-sm font-medium animate-pulse">
                      <Activity className="w-4 h-4" /> Inference running...
                    </div>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* NEW: The Debug Terminal */}
        <DebugTerminal logs={logs} />
      </div>

      {/* Right Column: The Chat History */}
      <div className="w-[400px] flex flex-col h-[750px]">
        <Card className="flex-1 flex flex-col shadow-lg border-border/50 overflow-hidden">
          <CardHeader className="bg-secondary/10 border-b py-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">Session Timeline</CardTitle>
              
              {isHydrated && (
                <div className="flex gap-2">
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
                    className="text-primary hover:bg-primary/10 hover:text-primary"
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
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    title="Delete Session"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>

                  <Button 
                    onClick={downloadSession} 
                    disabled={messages.length === 0}
                    variant="outline" 
                    size="sm" 
                    className="gap-2"
                  >
                    <Download className="w-4 h-4" /> Full Session
                  </Button>
                  <Button 
                    onClick={playStitchedSession} 
                    disabled={messages.length === 0}
                    variant="default" 
                    size="sm" 
                    className="gap-2"
                  >
                    <Play className="w-4 h-4" /> Play All
                  </Button>
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent className="flex-1 overflow-y-auto p-4 space-y-4">
            
            {messages.length === 0 && (
              <div className="text-center text-muted-foreground italic mt-20">
                Hit record, play a melody, and send it to start the jam.
              </div>
            )}

            {messages.map((msg) => (
              <div 
                key={msg.id} 
                className={`flex flex-col ${msg.sender === "user" ? "items-end" : "items-start"}`}
              >
                <div className="flex items-center gap-2 mb-1 px-1">
                  {msg.sender === "user" ? <User className="w-3 h-3 opacity-50" /> : <Bot className="w-3 h-3 opacity-50 text-primary" />}
                  <span className="text-xs font-semibold text-muted-foreground">
                    {msg.sender === "user" ? "You" : "Amadeus"}
                  </span>
                </div>
                
                <div className={`p-3 rounded-xl w-full max-w-[90%] shadow-sm ${
                  msg.sender === "user" 
                    ? "bg-primary text-primary-foreground rounded-tr-none" 
                    : "bg-secondary border border-border/50 rounded-tl-none"
                }`}>
                  
                  <div className="mb-3">
                     <PianoRoll 
                       notes={msg.notes} 
                       isPlaying={playingMessageId === msg.id}
                       audioContext={audioContext.current}
                       playbackStartTime={activePlayStartTime}
                       color={msg.sender === "user" ? "#ffffff" : "#3b82f6"} 
                     />
                  </div>

                  <div className="flex items-center justify-between gap-6">
                    <span className="text-sm font-mono opacity-80">{msg.notes.length} notes</span>
                    <div className="flex gap-2">
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        className={`h-7 w-7 ${msg.sender === "user" ? "hover:bg-black/10" : "hover:bg-primary/10"}`}
                        onClick={() => downloadMessage(msg)}
                        title="Download this part"
                      >
                        <Download className="w-3 h-3" />
                      </Button>
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        className={`h-7 w-7 ${msg.sender === "user" ? "hover:bg-black/10" : "hover:bg-primary/10"}`}
                        onClick={() => playMessage(msg.id, msg.notes)}
                      >
                        <Play className="w-3 h-3" />
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