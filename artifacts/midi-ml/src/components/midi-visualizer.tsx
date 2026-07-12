"use client";

import { useEffect, useRef, useState } from "react";
import { Midi } from "@tonejs/midi";

interface MidiVisualizerProps {
  midiUrl: string;
  audioElement: HTMLAudioElement | null;
  color?: string;
}

export function MidiVisualizer({ midiUrl, audioElement, color = "#3b82f6" }: MidiVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [notes, setNotes] = useState<{ pitch: number; timeSec: number; durationSec: number }[]>([]);

  // 1. Fetch and Parse the MIDI File
  useEffect(() => {
    if (!midiUrl) return;
    
    const fetchMidi = async () => {
      try {
        const response = await fetch(midiUrl);
        const arrayBuffer = await response.arrayBuffer();
        const parsedMidi = new Midi(arrayBuffer);
        
        const extractedNotes: { pitch: number; timeSec: number; durationSec: number }[] = [];
        parsedMidi.tracks.forEach(track => {
          track.notes.forEach(note => {
            extractedNotes.push({
              pitch: note.midi,
              timeSec: note.time, 
              durationSec: note.duration
            });
          });
        });
        
        setNotes(extractedNotes);
      } catch (err) {
        console.error("Failed to parse MIDI for visualizer", err);
      }
    };

    fetchMidi();
  }, [midiUrl]);

  // 2. The Render Loop (Locked to the <audio> tag)
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

      // Draw Notes
      notes.forEach((n) => {
        const x = scrollOffset + ((n.timeSec - minTime) * PIXELS_PER_SECOND);
        const y = canvas.height - ((n.pitch - minPitch) * rowHeight) - rowHeight;
        const width = Math.max(n.durationSec * PIXELS_PER_SECOND, 4); 

        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(x, y, width, rowHeight * 0.8, 4);
        ctx.fill();
      });

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
  }, [notes, audioElement, color]);

  return (
    <canvas 
      ref={canvasRef} 
      width={600} 
      height={150} 
      className="w-full h-32 bg-black/5 rounded-md border border-border/50"
    />
  );
}