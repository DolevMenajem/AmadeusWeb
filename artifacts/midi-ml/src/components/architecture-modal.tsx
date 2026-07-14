"use client";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { BrainCircuit, Cpu, Network, Clock } from "lucide-react";

export function ArchitectureModal() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2 border-primary/20 text-primary hover:bg-primary/10">
          <BrainCircuit className="w-4 h-4" /> System Architecture
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl bg-card border-primary/20 shadow-2xl">
        <DialogHeader>
          <DialogTitle className="text-2xl flex items-center gap-2">
            <Cpu className="w-6 h-6 text-primary" /> Amadeus Engine Pipeline
          </DialogTitle>
          <DialogDescription>
            A technical breakdown of the dual-model PyTorch backend and temporal translation layer.
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-6 py-4">
          <div className="space-y-2">
            <h4 className="font-semibold text-foreground flex items-center gap-2">
              <Network className="w-4 h-4 text-primary" /> 1. The Dual-Brain Models
            </h4>
            <p className="text-sm text-muted-foreground leading-relaxed">
              <strong>REMI (Revamped MIDI):</strong> A linear, single-track transformer. It processes music as a 1D sequence of events (Note On, Pitch, Velocity, Duration), excelling at classical piano continuity.
              <br/><br/>
              <strong>Octuple:</strong> A multi-dimensional, full-band model. It compresses 8 distinct musical attributes (including Time Signature, Tempo, and Instrument) into unified token tuples, allowing for complex multi-track generation.
            </p>
          </div>

          <div className="space-y-2">
            <h4 className="font-semibold text-foreground flex items-center gap-2">
              <Cpu className="w-4 h-4 text-primary" /> 2. The Parsing & Grid Injection
            </h4>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Standard JSON note arrays lack the mathematical boundaries required by the tokenizer. The backend uses the C++ <code className="bg-secondary px-1 py-0.5 rounded text-primary">symusic</code> library to artificially inject a 120-BPM tempo and 4/4 time signature, establishing a rigid temporal grid before inference.
            </p>
          </div>

          <div className="space-y-2">
            <h4 className="font-semibold text-foreground flex items-center gap-2">
              <Clock className="w-4 h-4 text-primary" /> 3. Temporal Dilation (The Resampler)
            </h4>
            <p className="text-sm text-muted-foreground leading-relaxed">
              To conserve memory, the AI compresses time during inference, operating at a microscopic resolution of <strong>8 TPQ</strong> (Ticks Per Quarter Note). Before the response reaches the frontend, the timeline is mathematically decompressed back to the browser's native high-definition <strong>480 TPQ</strong>, preventing playback collapse.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}