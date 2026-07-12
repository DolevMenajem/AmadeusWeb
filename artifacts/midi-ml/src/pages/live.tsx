"use client";

import { useState, useRef, useEffect } from "react";
import Soundfont from "soundfont-player";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Music, Mic, Square, Activity, Volume2, Play, User, Bot, Download } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Slider } from "@/components/ui/slider";

const MS_TO_TICKS = 0.96; 
const TICKS_TO_MS = 1.0416;

interface JamNote {
  pitch: number;
  time: number;
  duration: number;
  velocity: number;
}

// NEW: Chat Message Architecture
interface ChatMessage {
  id: string;
  sender: "user" | "ai";
  notes: JamNote[];
  timestamp: Date;
}

// Add this right below your JamNote and ChatMessage interfaces

interface PianoRollProps {
  notes: JamNote[];
  isPlaying: boolean;
  audioContext: AudioContext | null;
  playbackStartTime: number | null;
  color?: string; // To differentiate User (blue) from AI (gray)
}

function PianoRoll({ notes, isPlaying, audioContext, playbackStartTime, color = "#3b82f6" }: PianoRollProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const TICKS_TO_MS = 1.0416;
  const PIXELS_PER_SECOND = 80; // How fast the roll scrolls

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || notes.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // 1. Math: Find boundaries to frame the notes perfectly
    const minTime = Math.min(...notes.map(n => n.time));
    const maxTime = Math.max(...notes.map(n => n.time + n.duration));
    const totalDurationSec = ((maxTime - minTime) * TICKS_TO_MS) / 1000;
    
    const pitches = notes.map(n => n.pitch);
    const minPitch = Math.min(...pitches) - 4; // Add padding bottom
    const maxPitch = Math.max(...pitches) + 4; // Add padding top
    const pitchRange = maxPitch - minPitch;
    const rowHeight = canvas.height / pitchRange;

    let animationId: number;

    // 2. The Render Loop
    const draw = () => {
      // Clear the canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Determine where the playhead is right now
      let currentPlayTimeSec = 0;
      if (isPlaying && audioContext && playbackStartTime) {
        currentPlayTimeSec = audioContext.currentTime - playbackStartTime;
        // Stop animating if we've passed the end of the clip
        if (currentPlayTimeSec > totalDurationSec + 0.5) currentPlayTimeSec = totalDurationSec + 0.5;
      }

      // We want the playhead fixed at 10% of the canvas width, and the notes slide left
      const playheadX = canvas.width * 0.1; 
      const scrollOffset = playheadX - (currentPlayTimeSec * PIXELS_PER_SECOND);

      // Draw horizontal grid lines (Piano keys)
      ctx.lineWidth = 1;
      for (let i = 0; i <= pitchRange; i++) {
        const y = i * rowHeight;
        ctx.strokeStyle = "rgba(150, 150, 150, 0.1)";
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
      }

      // Draw the Notes
      notes.forEach((n) => {
        const startTimeSec = ((n.time - minTime) * TICKS_TO_MS) / 1000;
        const durationSec = (n.duration * TICKS_TO_MS) / 1000;
        
        const x = scrollOffset + (startTimeSec * PIXELS_PER_SECOND);
        const y = canvas.height - ((n.pitch - minPitch) * rowHeight) - rowHeight;
        const width = Math.max(durationSec * PIXELS_PER_SECOND, 4); // Min width of 4px

        // Draw rounded rectangle for the note
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(x, y, width, rowHeight * 0.8, 4);
        ctx.fill();
      });

      // Draw the Playhead (Red line)
      if (isPlaying) {
        ctx.strokeStyle = "rgba(239, 68, 68, 0.8)"; // Red-500
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(playheadX, 0);
        ctx.lineTo(playheadX, canvas.height);
        ctx.stroke();
      }

      // Loop to next frame
      animationId = requestAnimationFrame(draw);
    };

    draw();

    return () => cancelAnimationFrame(animationId);
  }, [notes, isPlaying, audioContext, playbackStartTime, color]);

  return (
    <canvas 
      ref={canvasRef} 
      width={400} 
      height={100} 
      className="w-full h-24 bg-black/5 rounded-md border border-border/50"
    />
  );
}

export default function LiveExtend() {
  const { toast } = useToast();
  const [isReady, setIsReady] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isWaitingForAI, setIsWaitingForAI] = useState(false);
  
  // State: The Conversation History & Current Buffer
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [currentRecording, setCurrentRecording] = useState<JamNote[]>([]);
  const [activeKeys, setActiveKeys] = useState<number[]>([]);
  
  const [temperature, setTemperature] = useState([0.5]); 
  const [numGenerate, setNumGenerate] = useState([64]);  

  // Playback Trackers
  const [playingMessageId, setPlayingMessageId] = useState<string | null>(null);
  const [activePlayStartTime, setActivePlayStartTime] = useState<number | null>(null);

  const audioContext = useRef<AudioContext | null>(null);
  const instrument = useRef<Soundfont.Player | null>(null);
  const recordingStartTime = useRef<number>(0);
  const activeNotesMap = useRef<Map<number, number>>(new Map()); 

  const initializeAudio = async () => {
    try {
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      audioContext.current = new AC();
      instrument.current = await Soundfont.instrument(audioContext.current, "acoustic_grand_piano");
      setIsReady(true);
      toast({ title: "Audio Ready", description: "Piano loaded successfully!" });
    } catch (err) {
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

  // --- RECORDING & AI HANDOFF LOGIC ---

  const startRecording = () => {
    setCurrentRecording([]);
    activeNotesMap.current.clear();
    recordingStartTime.current = Date.now();
    setIsRecording(true);
  };

  const stopAndSend = async () => {
    setIsRecording(false);
    if (currentRecording.length === 0) return;

    // 1. Package User's notes into a message
    const userMsg: ChatMessage = {
      id: Math.random().toString(36).substring(7),
      sender: "user",
      notes: [...currentRecording],
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setCurrentRecording([]);

    // 2. Fetch AI Response
    setIsWaitingForAI(true);
    try {
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

      const data = await response.json();
      const aiNotes: JamNote[] = data.notes;

      // 3. Package AI's notes into a message
      if (aiNotes && aiNotes.length > 0) {
        const aiMsg: ChatMessage = {
          id: Math.random().toString(36).substring(7),
          sender: "ai",
          notes: aiNotes,
          timestamp: new Date(),
        };
        setMessages((prev) => [...prev, aiMsg]);
      } else {
        toast({ title: "AI was silent", description: "The model returned no notes." });
      }
    } catch (err) {
      toast({ variant: "destructive", title: "Error", description: String(err) });
    } finally {
      setIsWaitingForAI(false);
    }
  };

  // --- PLAYBACK LOGIC ---

  const playMessage = (msgId: string, notesToPlay: JamNote[]) => {
    if (!instrument.current || !audioContext.current || notesToPlay.length === 0) return;

    const now = audioContext.current.currentTime + 0.1; 
    
    // Tell the Visualizer that THIS message is playing, starting exactly at "now"
    setPlayingMessageId(msgId);
    setActivePlayStartTime(now);

    const sortedNotes = [...notesToPlay].sort((a, b) => a.time - b.time);
    const minTime = sortedNotes[0].time;
    let maxDurationSec = 0;

    sortedNotes.forEach((n) => {
      const startTimeSec = ((n.time - minTime) * TICKS_TO_MS) / 1000;
      const durationSec = (n.duration * TICKS_TO_MS) / 1000;
      instrument.current!.play(n.pitch.toString(), now + startTimeSec, { duration: durationSec });
      
      if (startTimeSec + durationSec > maxDurationSec) maxDurationSec = startTimeSec + durationSec;
    });

    // Automatically stop the visualizer when the clip ends
    setTimeout(() => {
      setPlayingMessageId(null);
    }, (maxDurationSec + 0.5) * 1000);
  };

  const playStitchedSession = () => {
    if (!instrument.current || !audioContext.current || messages.length === 0) return;

    let now = audioContext.current.currentTime + 0.1; 

    messages.forEach((msg) => {
      if (msg.notes.length === 0) return;
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

      // Advance the timeline clock by the length of this message, plus a tiny 0.2s breath between turns
      now += maxTimeInMsg + 0.2; 
    });

    toast({ title: "Playing Session", description: "Stitching back-to-back..." });
  };

// --- EXPORT LOGIC ---

  // Universal helper to send ANY array of notes to the Python export route
  const exportNotesToMIDI = async (notes: JamNote[], filename: string) => {
    try {
      const response = await fetch("/api/jam/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The export route ignores num_generate and temp, but the FastAPI schema requires them
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
      
      toast({ title: "Exported", description: `${filename} downloaded successfully.` });
    } catch (err) {
      toast({ variant: "destructive", title: "Export Error", description: String(err) });
    }
  };

  // 1. Download a single message (User or AI)
  const downloadMessage = (msg: ChatMessage) => {
    const safeId = msg.id.substring(0, 4);
    exportNotesToMIDI(msg.notes, `jam_${msg.sender}_${safeId}.mid`);
  };

  // 2. Download the entire stitched timeline
  const downloadSession = () => {
    if (messages.length === 0) return;
    
    let combinedNotes: JamNote[] = [];
    let currentTickOffset = 0; // The master clock for the stitched timeline

    messages.forEach((msg) => {
      if (msg.notes.length === 0) return;
      
      const sorted = [...msg.notes].sort((a, b) => a.time - b.time);
      const minTime = sorted[0].time;
      let maxTimeInMsgTicks = 0;

      sorted.forEach((n) => {
        // Shift the note relative to the start of this turn, then add the master offset
        const shiftedTime = (n.time - minTime) + currentTickOffset;
        combinedNotes.push({ ...n, time: shiftedTime });

        // Calculate when this specific note finishes
        const noteEndTimeTicks = shiftedTime + n.duration;
        if (noteEndTimeTicks > maxTimeInMsgTicks) {
          maxTimeInMsgTicks = noteEndTimeTicks;
        }
      });

      // Advance the master clock to the end of this turn, plus a 1-beat breath (480 ticks)
      currentTickOffset = maxTimeInMsgTicks + 480; 
    });

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
      
      {/* Left Column: The Piano and Controls */}
      <div className="flex-1 space-y-6">
        <Card className="shadow-lg border-primary/20">
          <CardHeader className="text-center pb-4">
            <CardTitle className="text-2xl font-bold flex items-center justify-center gap-2">
              <Activity className="w-6 h-6 text-primary" /> Jam Controls
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
                {/* Virtual Keyboard */}
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
                
                {/* AI Controls */}
                <div className="grid grid-cols-2 gap-6 p-4 bg-secondary/5 rounded-lg border border-border/50">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between text-sm">
                      <label className="font-medium">Creativity</label>
                      <span className="font-mono text-muted-foreground">{temperature[0]}</span>
                    </div>
                    <Slider value={temperature} onValueChange={setTemperature} min={0.1} max={1.5} step={0.1} />
                  </div>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between text-sm">
                      <label className="font-medium">Length</label>
                      <span className="font-mono text-muted-foreground">{numGenerate[0]}</span>
                    </div>
                    <Slider value={numGenerate} onValueChange={setNumGenerate} min={16} max={128} step={16} />
                  </div>
                </div>

                {/* Main Action Buttons */}
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
                      <Activity className="w-4 h-4" /> Amadeus is thinking...
                    </div>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Right Column: The Chat History */}
      <div className="w-[400px] flex flex-col h-[600px]">
        <Card className="flex-1 flex flex-col shadow-lg border-border/50 overflow-hidden">
          <CardHeader className="bg-secondary/10 border-b py-4">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">Session Timeline</CardTitle>
              <div className="flex gap-2">
                <Button 
                  onClick={downloadSession} 
                  disabled={messages.length === 0}
                  variant="outline" 
                  size="sm" 
                  className="gap-2"
                  title="Download Stitched Session"
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
                  
                  {/* THE NEW VISUALIZER */}
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