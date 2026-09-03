"use client";

import { useEffect, useRef, useState } from "react";
import { Midi } from "@tonejs/midi";

interface MidiVisualizerProps {
  midiUrl: string;
  inputMidiUrl?: string; // The seed file for seam calculation
  seamTime?: number;     // Explicit seam (seconds); wins over inputMidiUrl detection
  audioElement: HTMLAudioElement | null;
  color?: string;
}

interface ExtractedNote {
  pitch: number;
  timeSec: number;
  durationSec: number;
  color: string;
}

export function MidiVisualizer({ midiUrl, inputMidiUrl, seamTime, audioElement, color = "#3b82f6" }: MidiVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [notes, setNotes] = useState<ExtractedNote[]>([]);
  const [seamTimeSec, setSeamTimeSec] = useState<number | null>(null);

  useEffect(() => {
    if (!midiUrl) return;
    let isMounted = true;

    const fetchMidiData = async () => {
      try {
        // 1. Fetch the AI's final masterpiece
        const response = await fetch(midiUrl);
        const arrayBuffer = await response.arrayBuffer();
        const parsedMidi = new Midi(arrayBuffer);
        
        let detectedSeam: number | null = null;

        // 2a. An explicitly provided seam time wins (showcase page computes it
        // from an extension-only file when no seed file is available)
        if (seamTime != null) {
          detectedSeam = seamTime;
          if (isMounted) setSeamTimeSec(seamTime);
        }

        // 2b. Otherwise fetch the original seed file to find the AI Takeover timestamp
        if (detectedSeam === null && inputMidiUrl) {
          try {
            const inRes = await fetch(inputMidiUrl);
            if (inRes.ok) {
              const inBuf = await inRes.arrayBuffer();
              const inMidi = new Midi(inBuf);
              let maxTime = 0;
              // Find the absolute last second of the original file
              inMidi.tracks.forEach(t => t.notes.forEach(n => {
                if (n.time + n.duration > maxTime) maxTime = n.time + n.duration;
              }));
              detectedSeam = maxTime;
              if (isMounted) setSeamTimeSec(maxTime);
            }
          } catch (err) {
            console.warn("Could not fetch seed MIDI for seam calculation", err);
          }
        }
        
        const extractedNotes: ExtractedNote[] = [];
        
        // 3. Parse Tracks and Assign Multi-Track Colors
        parsedMidi.tracks.forEach((track, idx) => {
          let trackColor = color; 
          
          // Detect Instrument Types based on MIDI Channel or Family
          if (track.channel === 9 || track.instrument.percussion) {
            trackColor = "#ef4444"; // Red for Drums
          } else if (track.instrument.family === 'bass' || track.name.toLowerCase().includes('bass')) {
            trackColor = "#a855f7"; // Purple for Bass
          } else if (idx === 0 || track.instrument.family === 'piano') {
            trackColor = "#3b82f6"; // Blue for Piano/Melody
          } else {
            trackColor = "#10b981"; // Green for Strings/Other
          }

          track.notes.forEach(note => {
            // UX Magic: If the note happens before the seam, turn it gray!
            const isOriginal = detectedSeam && note.time < detectedSeam - 0.1;
            
            extractedNotes.push({
              pitch: note.midi,
              timeSec: note.time, 
              durationSec: note.duration,
              color: isOriginal ? "#6b7280" : trackColor // Gray out the seed track
            });
          });
        });
        
        if (isMounted) setNotes(extractedNotes);
      } catch (err) {
        console.error("Failed to parse MIDI for visualizer", err);
      }
    };

    fetchMidiData();
    return () => { isMounted = false; };
  }, [midiUrl, inputMidiUrl, seamTime, color]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || notes.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const minTime = Math.min(...notes.map(n => n.timeSec));
    const pitches = notes.map(n => n.pitch);
    const minPitch = Math.min(...pitches) - 4; 
    const maxPitch = Math.max(...pitches) + 4; 
    const pitchRange = maxPitch - minPitch;
    const rowHeight = canvas.height / pitchRange;
    const PIXELS_PER_SECOND = 80;

    let animationId: number;

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      let currentPlayTimeSec = 0;
      let isPlaying = false;
      
      if (audioElement) {
        currentPlayTimeSec = audioElement.currentTime;
        isPlaying = !audioElement.paused && !audioElement.ended;
      }

      const playheadX = canvas.width * 0.1; 
      const scrollOffset = playheadX - (currentPlayTimeSec * PIXELS_PER_SECOND);

      // Draw Grid
      ctx.lineWidth = 1;
      for (let i = 0; i <= pitchRange; i++) {
        const y = i * rowHeight;
        ctx.strokeStyle = "rgba(150, 150, 150, 0.1)";
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
      }

      // Draw Notes with their custom assigned colors
      notes.forEach((n) => {
        const x = scrollOffset + ((n.timeSec - minTime) * PIXELS_PER_SECOND);
        const y = canvas.height - ((n.pitch - minPitch) * rowHeight) - rowHeight;
        const width = Math.max(n.durationSec * PIXELS_PER_SECOND, 4); 

        ctx.fillStyle = n.color;
        ctx.beginPath();
        ctx.roundRect(x, y, width, rowHeight * 0.8, 4);
        ctx.fill();
      });

      // Draw The "AI Takeover" Seam Line
      if (seamTimeSec !== null) {
        const seamX = scrollOffset + ((seamTimeSec - minTime) * PIXELS_PER_SECOND);
        if (seamX > -50 && seamX < canvas.width + 50) {
          ctx.shadowBlur = 10;
          ctx.shadowColor = "rgba(234, 179, 8, 0.8)"; 
          
          ctx.strokeStyle = "rgba(234, 179, 8, 1)"; // Bright Yellow
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 5]); // Dashed line
          ctx.beginPath();
          ctx.moveTo(seamX, 0);
          ctx.lineTo(seamX, canvas.height);
          ctx.stroke();
          
          ctx.setLineDash([]); 
          ctx.shadowBlur = 0; 
          
          ctx.fillStyle = "rgba(234, 179, 8, 1)";
          ctx.font = "bold 10px sans-serif";
          ctx.fillText("AI TAKEOVER", seamX + 6, 16);
        }
      }

      // Draw Playhead
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
  }, [notes, seamTimeSec, audioElement]);

  return (
    <canvas 
      ref={canvasRef} 
      width={600} 
      height={150} 
      className="w-full h-32 bg-black/10 rounded-md border border-border/50 shadow-inner"
    />
  );
}