import { useState } from "react";
import { Midi } from "@tonejs/midi";
import { useUploadMidiFile, useListJobs, getListJobsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

// UI Components
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MidiFileUpload } from "@/components/midi-file-upload";
import { MidiVisualizer } from "@/components/midi-visualizer";
import { MidiPlayer } from "@/components/midi-player";

// Hooks & Icons
import { useToast } from "@/hooks/use-toast";
import { Download, BrainCircuit, Presentation, FileMusic, Upload, History, Save, Play } from "lucide-react";

type RefKind = "seed" | "extension";

interface FileShowcase {
  kind: "files";
  fullName: string;        // uploaded filename of the full result
  refName: string | null;
  refKind: RefKind;
  seamTime: number | null; // seconds; used when refKind === "extension"
  audioName: string | null; // rendered WAV filename, when available
  savedJobId: number | null; // set once committed to the job history
}

interface JobShowcase {
  kind: "job";
  jobId: number;
  hasInput: boolean;       // seam comes from ?type=input when true
  seamTime: number | null; // computed from the extension file otherwise
  label: string;
}

type Loaded = FileShowcase | JobShowcase;

// Last note-off time (seconds) of a parsed MIDI file
const midiEndSec = (midi: Midi) => {
  let end = 0;
  midi.tracks.forEach((t) => t.notes.forEach((n) => {
    if (n.time + n.duration > end) end = n.time + n.duration;
  }));
  return end;
};

export default function Showcase() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const uploadMutation = useUploadMidiFile();
  const { data: jobs } = useListJobs();

  const [fullFile, setFullFile] = useState<File | null>(null);
  const [refFile, setRefFile] = useState<File | null>(null);
  const [refKind, setRefKind] = useState<RefKind>("seed");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [wavFailed, setWavFailed] = useState(false);
  const [audioEl, setAudioEl] = useState<HTMLAudioElement | null>(null);

  // Completed jobs with output files — both real extensions and saved showcases
  const historyJobs = ((jobs as any[]) ?? []).filter(
    (j) => j.status === "completed" && j.outputFilename && (j.type === "extend" || j.type === "showcase")
  );

  // ---- Load from uploaded files ----
  const loadShowcase = async () => {
    if (!fullFile) {
      toast({ variant: "destructive", title: "Missing file", description: "Select the full result MIDI first." });
      return;
    }
    setLoading(true);
    setLoaded(null);
    setWavFailed(false);
    try {
      const fullUp = await uploadMutation.mutateAsync({ data: { file: fullFile } });
      let refName: string | null = null;
      if (refFile) {
        const refUp = await uploadMutation.mutateAsync({ data: { file: refFile } });
        refName = refUp.filename;
      }

      // Server-side WAV render (falls back to in-browser piano if unavailable)
      let audioName: string | null = null;
      try {
        const res = await fetch(`/api/files/${fullUp.filename}/render`, { method: "POST" });
        if (res.ok) {
          const info = await res.json();
          if (info.audio) audioName = info.filename;
        }
      } catch { /* piano fallback covers it */ }

      // Extension-only reference: seam = full end − extension length
      let seamTime: number | null = null;
      if (refName && refKind === "extension") {
        const [fullBuf, extBuf] = await Promise.all([
          fetch(`/api/files/${fullUp.filename}`).then((r) => r.arrayBuffer()),
          fetch(`/api/files/${refName}`).then((r) => r.arrayBuffer()),
        ]);
        seamTime = Math.max(0, midiEndSec(new Midi(fullBuf)) - midiEndSec(new Midi(extBuf)));
      }

      setLoaded({ kind: "files", fullName: fullUp.filename, refName, refKind, seamTime, audioName, savedJobId: null });
    } catch (err: any) {
      toast({ variant: "destructive", title: "Load failed", description: err?.message || "Could not load the showcase files." });
    } finally {
      setLoading(false);
    }
  };

  // ---- Load an old job from the history ----
  const loadJob = async (job: any) => {
    setLoading(true);
    setLoaded(null);
    setWavFailed(false);
    try {
      let seamTime: number | null = null;
      if (!job.inputFilename) {
        // No seed on record — derive the seam from the extension file if one
        // exists (the endpoint falls back to the full file when it doesn't,
        // which the sanity check below filters out).
        try {
          const [fullBuf, extBuf] = await Promise.all([
            fetch(`/api/jobs/${job.id}/download?type=full`).then((r) => r.arrayBuffer()),
            fetch(`/api/jobs/${job.id}/download?type=extension`).then((r) => r.arrayBuffer()),
          ]);
          const fullEnd = midiEndSec(new Midi(fullBuf));
          const extEnd = midiEndSec(new Midi(extBuf));
          if (extEnd < fullEnd - 0.05) seamTime = fullEnd - extEnd;
        } catch { /* render without a seam line */ }
      }
      setLoaded({
        kind: "job",
        jobId: job.id,
        hasInput: !!job.inputFilename,
        seamTime,
        label: `Job #${job.id} — ${job.inputFilename || job.outputFilename}`,
      });
    } finally {
      setLoading(false);
    }
  };

  // ---- Commit the current file-loaded showcase into the job history ----
  const saveToHistory = async () => {
    if (!loaded || loaded.kind !== "files" || loaded.savedJobId) return;
    setSaving(true);
    try {
      const res = await fetch("/api/jobs/showcase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullFilename: loaded.fullName,
          inputFilename: loaded.refKind === "seed" ? loaded.refName : null,
          extensionFilename: loaded.refKind === "extension" ? loaded.refName : null,
        }),
      });
      if (!res.ok) throw new Error("Save failed");
      const job = await res.json();
      setLoaded({ ...loaded, savedJobId: job.id });
      queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
      toast({ title: "Saved", description: `Showcase stored in the job history as job #${job.id}.` });
    } catch (err: any) {
      toast({ variant: "destructive", title: "Save failed", description: err?.message || "Could not save the showcase." });
    } finally {
      setSaving(false);
    }
  };

  // ---- URLs for the render card, independent of how the showcase was loaded ----
  const urls = loaded && (loaded.kind === "files"
    ? {
        midi: `/api/files/${loaded.fullName}`,
        input: loaded.refKind === "seed" && loaded.refName ? `/api/files/${loaded.refName}` : undefined,
        seam: loaded.refKind === "extension" && loaded.seamTime != null ? loaded.seamTime : undefined,
        audio: loaded.audioName ? `/api/files/${loaded.audioName}` : null,
      }
    : {
        midi: `/api/jobs/${loaded.jobId}/download?type=full`,
        input: loaded.hasInput ? `/api/jobs/${loaded.jobId}/download?type=input` : undefined,
        seam: !loaded.hasInput && loaded.seamTime != null ? loaded.seamTime : undefined,
        audio: `/api/jobs/${loaded.jobId}/download?type=audio`,
      });

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">

      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Presentation className="w-6 h-6 text-primary" /> Showcase
        </h1>
        <p className="text-muted-foreground mt-1">
          Replay a finished result and watch exactly where the AI takes over — no generation, instant and reliable for demos.
        </p>
      </div>

      <div className="grid lg:grid-cols-2 gap-8 items-start">
        <div className="space-y-8">

          {/* Job History */}
          <Card className="bg-gradient-to-br from-card to-background/50 border-border shadow-md shadow-black/20">
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><History className="w-5 h-5 text-primary" /> Load From History</CardTitle>
              <CardDescription>Completed jobs and saved showcases, straight from the database.</CardDescription>
            </CardHeader>
            <CardContent>
              {historyJobs.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">No completed jobs yet — run an extension or save a showcase below.</p>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                  {historyJobs.map((job) => (
                    <div key={job.id} className="flex items-center justify-between gap-3 p-2.5 bg-secondary/10 border border-border/50 rounded-lg">
                      <div className="min-w-0 flex items-center gap-2">
                        <Badge variant="secondary" className="shrink-0">{job.type === "showcase" ? "Showcase" : "Extend"}</Badge>
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">Job #{job.id}{job.inputFilename ? ` — ${job.inputFilename}` : ""}</p>
                          {job.completedAt && <p className="text-xs text-muted-foreground truncate">{new Date(job.completedAt).toLocaleString()}</p>}
                        </div>
                      </div>
                      <Button size="sm" variant="secondary" className="gap-1.5 shrink-0" disabled={loading} onClick={() => loadJob(job)}>
                        <Play className="w-3 h-3" /> Load
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* File Inputs */}
          <Card className="bg-gradient-to-br from-card to-background/50 border-border shadow-md shadow-black/20">
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Upload className="w-5 h-5 text-primary" /> Load From Files</CardTitle>
              <CardDescription>Pick a previously generated result. The seam reference is optional but draws the AI-takeover line.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">

              <div className="space-y-3 p-4 bg-secondary/10 border border-border rounded-lg">
                <label className="text-sm font-semibold flex items-center gap-2">
                  <FileMusic className="w-4 h-4 text-primary" /> Full result (song + AI extension)
                </label>
                <MidiFileUpload selectedFile={fullFile} onFileSelect={setFullFile} disabled={loading} />
              </div>

              <div className="space-y-3 p-4 bg-secondary/10 border border-border rounded-lg">
                <label className="text-sm font-semibold flex items-center gap-2">
                  <FileMusic className="w-4 h-4 text-primary" /> Seam reference (optional)
                </label>
                <select
                  value={refKind}
                  onChange={(e) => setRefKind(e.target.value as RefKind)}
                  disabled={loading}
                  className="flex h-10 w-full rounded-md border border-input bg-background/50 backdrop-blur-sm px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="seed">Original song (the seed that was extended)</option>
                  <option value="extension">Extension only (the AI part by itself)</option>
                </select>
                <MidiFileUpload selectedFile={refFile} onFileSelect={setRefFile} disabled={loading} />
              </div>

              <Button onClick={loadShowcase} disabled={loading || !fullFile} className="w-full gap-2 shadow-md shadow-primary/20">
                {loading ? (
                  <><div className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin" /> Preparing render...</>
                ) : (
                  <><Presentation className="w-4 h-4" /> Load Showcase</>
                )}
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Render */}
        {loaded && urls && (
          <Card className="bg-gradient-to-br from-card to-background/50 border-border shadow-md shadow-black/20">
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><BrainCircuit className="w-5 h-5 text-primary" /> AI Studio Render</CardTitle>
              <CardDescription>
                {loaded.kind === "job" ? loaded.label : "Gray notes = human input · colored notes = AI continuation · yellow line = AI takeover."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">

              <div className="ring-1 ring-border rounded-lg overflow-hidden bg-black/20">
                <MidiVisualizer
                  midiUrl={urls.midi}
                  inputMidiUrl={urls.input}
                  seamTime={urls.seam}
                  audioElement={audioEl}
                />
              </div>

              {urls.audio && !wavFailed ? (
                <audio
                  ref={setAudioEl}
                  controls
                  className="w-full h-10 rounded-md shadow-sm"
                  src={urls.audio}
                  controlsList="nodownload"
                  onError={() => setWavFailed(true)}
                >
                  Your browser does not support the audio element.
                </audio>
              ) : (
                <MidiPlayer compact url={urls.midi} label="Piano preview (in-browser render)" />
              )}

              <div className="grid grid-cols-2 gap-3">
                <Button asChild variant="outline" className="w-full gap-2">
                  <a href={urls.midi} download>
                    <Download className="w-4 h-4" /> Download
                  </a>
                </Button>
                {loaded.kind === "files" && (
                  loaded.savedJobId ? (
                    <Button variant="secondary" className="w-full gap-2" disabled>
                      <Save className="w-4 h-4" /> Saved as job #{loaded.savedJobId}
                    </Button>
                  ) : (
                    <Button onClick={saveToHistory} disabled={saving} className="w-full gap-2 shadow-sm shadow-primary/20">
                      {saving ? (
                        <><div className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin" /> Saving...</>
                      ) : (
                        <><Save className="w-4 h-4" /> Save to history</>
                      )}
                    </Button>
                  )
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
