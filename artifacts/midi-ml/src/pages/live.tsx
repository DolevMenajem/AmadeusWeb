"use client";

import { useState, useRef, useEffect } from "react";
import Soundfont from "soundfont-player";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Music, Mic, Square, Send, Activity, Volume2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Slider } from "@/components/ui/slider";

// Standard mapping to convert milliseconds to MIDI ticks (assuming 120 BPM)
const MS_TO_TICKS = 0.96; 
const TICKS_TO_MS = 1.0416;

interface JamNote {
  pitch: number;
  time: number;
  duration: number;
  velocity: number;
}

export default function LiveExtend() {
  const { toast } = useToast();
  const [isReady, setIsReady] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isWaitingForAI, setIsWaitingForAI] = useState(false);
  const [recordedNotes, setRecordedNotes] = useState<JamNote[]>([]);
  const [activeKeys, setActiveKeys] = useState<number[]>([]);
  const [temperature, setTemperature] = useState([0.5]); // Default safe temperature
  const [numGenerate, setNumGenerate] = useState([64]);  // Default 64 notes

  const audioContext = useRef<AudioContext | null>(null);
  const instrument = useRef<Soundfont.Player | null>(null);
  const recordingStartTime = useRef<number>(0);
  const activeNotesMap = useRef<Map<number, number>>(new Map()); // Maps pitch to start time

  // Initializes the browser's audio engine (Requires user click due to browser security)
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

  // Note Interaction
  const playNote = (pitch: number) => {
    if (!instrument.current || !audioContext.current) return;
    
    // Play sound
    instrument.current.play(pitch.toString(), audioContext.current.currentTime, { duration: 2 });
    setActiveKeys((prev) => [...prev, pitch]);

    // Record note start time if we are recording
    if (isRecording) {
      const startTimeMs = Date.now() - recordingStartTime.current;
      activeNotesMap.current.set(pitch, startTimeMs);
    }
  };

  const stopNote = (pitch: number) => {
    setActiveKeys((prev) => prev.filter((p) => p !== pitch));
    
    // Finalize recorded note
    if (isRecording && activeNotesMap.current.has(pitch)) {
      const startTimeMs = activeNotesMap.current.get(pitch)!;
      const durationMs = (Date.now() - recordingStartTime.current) - startTimeMs;
      activeNotesMap.current.delete(pitch);

      // Quantize/Convert ms to ticks for the AI
      setRecordedNotes((prev) => [
        ...prev,
        {
          pitch,
          time: Math.round(startTimeMs * MS_TO_TICKS),
          duration: Math.max(Math.round(durationMs * MS_TO_TICKS), 120), // Enforce minimum duration
          velocity: 80, // Default velocity
        },
      ]);
    }
  };

  // UI Controls
  const toggleRecording = () => {
    if (isRecording) {
      setIsRecording(false);
    } else {
      setRecordedNotes([]);
      activeNotesMap.current.clear();
      recordingStartTime.current = Date.now();
      setIsRecording(true);
    }
  };

  const sendToAI = async () => {
    if (recordedNotes.length === 0) return;
    setIsWaitingForAI(true);

    try {
      const response = await fetch("/api/jam", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          notes: recordedNotes, 
          num_generate: numGenerate[0], 
          temperature: temperature[0] 
        }),
      });

      if (!response.ok) throw new Error("AI Jam Failed");

      const data = await response.json();
      const aiNotes: JamNote[] = data.notes;

      // Play back the AI's response immediately!
      if (instrument.current && audioContext.current && aiNotes.length > 0) {
        const now = audioContext.current.currentTime + 0.1; // Add tiny buffer
        aiNotes.forEach((n) => {
          const startTimeSec = (n.time * TICKS_TO_MS) / 1000;
          const durationSec = (n.duration * TICKS_TO_MS) / 1000;
          instrument.current!.play(n.pitch.toString(), now + startTimeSec, { duration: durationSec });
        });
        toast({ title: "AI Responded!", description: `Played ${aiNotes.length} notes.` });
      }
    } catch (err) {
      toast({ variant: "destructive", title: "Error", description: String(err) });
    } finally {
      setIsWaitingForAI(false);
    }
  };

  // A tiny slice of a piano for the UI (C4 to E5)
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
    <div className="w-full max-w-3xl mx-auto py-8">
      <Card className="shadow-lg border-primary/20">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold flex items-center justify-center gap-2">
            <Activity className="w-6 h-6 text-primary" /> Live Jam Room
          </CardTitle>
          <CardDescription>Call and Response with Amadeus Dual Brains in real-time.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-8">
          
          {/* Step 1: Initialize Audio Context */}
          {!isReady ? (
            <div className="flex flex-col items-center justify-center py-12 gap-4 text-muted-foreground">
              <Volume2 className="w-12 h-12 opacity-50" />
              <p>Click below to initialize the browser's audio engine.</p>
              <Button onClick={initializeAudio} size="lg" className="gap-2">
                <Music className="w-5 h-5" /> Connect Instrument
              </Button>
            </div>
          ) : (
            <>
              {/* Virtual Keyboard */}
              <div className="relative h-48 bg-secondary/20 rounded-t-xl border-b-4 border-primary/50 overflow-hidden flex justify-center p-4 select-none">
                {keyboardLayout.map((k) => (
                  <div
                    key={k.pitch}
                    onMouseDown={() => playNote(k.pitch)}
                    onMouseUp={() => stopNote(k.pitch)}
                    onMouseLeave={() => stopNote(k.pitch)}
                    className={`relative border border-foreground/20 rounded-b-md cursor-pointer transition-colors ${
                      k.isBlack 
                        ? "bg-zinc-900 w-8 h-24 -mx-4 z-10" 
                        : "bg-white w-12 h-40 z-0"
                    } ${activeKeys.includes(k.pitch) ? (k.isBlack ? "bg-primary/80" : "bg-primary/20") : ""}`}
                  />
                ))}
              </div>
              
              {/* AI Controls */}
              <div className="grid grid-cols-2 gap-6 p-4 bg-secondary/5 rounded-lg border border-border/50">
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-sm">
                    <label className="font-medium">Creativity (Temp)</label>
                    <span className="font-mono text-muted-foreground">{temperature[0]}</span>
                  </div>
                  <Slider 
                    value={temperature} 
                    onValueChange={setTemperature} 
                    min={0.1} max={1.5} step={0.1} 
                  />
                </div>
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-sm">
                    <label className="font-medium">Response Length</label>
                    <span className="font-mono text-muted-foreground">{numGenerate[0]} notes</span>
                  </div>
                  <Slider 
                    value={numGenerate} 
                    onValueChange={setNumGenerate} 
                    min={16} max={128} step={16} 
                  />
                </div>
              </div>

              {/* Controls */}
              <div className="flex items-center justify-between p-4 bg-secondary/10 rounded-lg">
                <div className="flex items-center gap-4">
                  <Button 
                    onClick={toggleRecording} 
                    variant={isRecording ? "destructive" : "default"}
                    className="w-32 gap-2 transition-all"
                  >
                    {isRecording ? <Square className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                    {isRecording ? "Stop" : "Record"}
                  </Button>
                  <div className="text-sm text-muted-foreground font-mono">
                    Notes captured: {recordedNotes.length}
                  </div>
                </div>

                <Button 
                  onClick={sendToAI} 
                  disabled={recordedNotes.length === 0 || isRecording || isWaitingForAI}
                  className="w-40 gap-2"
                >
                  {isWaitingForAI ? (
                    <><div className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin" /> Thinking...</>
                  ) : (
                    <><Send className="w-4 h-4" /> Send to AI</>
                  )}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}