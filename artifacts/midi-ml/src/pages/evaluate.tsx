import { useState } from "react";
import {
  useEvaluateMidi,
  useUploadMidiFile,
  getListJobsQueryKey,
  getGetStatsQueryKey,
  useGetJob,
  getGetJobQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { JobStatusBadge } from "@/components/job-status-badge";
import { Progress } from "@/components/ui/progress";
import { MidiFileUpload } from "@/components/midi-file-upload";
import { GraduationCap, Music2, Cpu, BarChart3, Target } from "lucide-react";

export default function Evaluate() {
  const [currentJobId, setCurrentJobId] = useState<number | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [targetGenre, setTargetGenre] = useState<string>("");
  const [formError, setFormError] = useState<string | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const uploadMutation = useUploadMidiFile();

  const evaluateMutation = useEvaluateMidi({
    mutation: {
      onSuccess: (data) => {
        toast({ title: "Job submitted", description: "Your MIDI file is being evaluated by the Lecturer." });
        setCurrentJobId(data.id);
        queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetStatsQueryKey() });
      },
      onError: (err: any) => {
        toast({ title: "Submission failed", description: err.message || "Unknown error", variant: "destructive" });
      },
    },
  });

  const { data: job } = useGetJob(currentJobId as number, {
    query: {
      enabled: !!currentJobId,
      queryKey: getGetJobQueryKey(currentJobId as number),
      refetchInterval: (query) => {
        if (!query.state.data) return 2000;
        return query.state.data.status === "pending" || query.state.data.status === "processing" ? 2000 : false;
      },
    },
  });

  const handleSubmit = () => {
    if (!targetGenre.trim()) { setFormError("Please specify your target genre."); return; }
    if (!selectedFile) { setFormError("Please select a MIDI file."); return; }
    
    setFormError(null);
    uploadMutation.mutate(
      { data: { file: selectedFile } },
      {
        onSuccess: (upload) => {
          // Send both the filename and the new target genre to the backend
          evaluateMutation.mutate({ 
            data: { 
              inputFilename: upload.filename, 
              targetGenre: targetGenre.trim() 
            } as any 
          });
        },
        onError: (err: any) => {
          toast({ title: "Upload failed", description: err.message || "Could not upload file", variant: "destructive" });
        },
      }
    );
  };

  const isPending = uploadMutation.isPending || evaluateMutation.isPending;
  const result = job?.evaluationResult as any;

  const ScoreBar = ({ label, score }: { label: string; score?: number }) => (
    <div className="space-y-1.5" data-testid={`score-${label.toLowerCase()}`}>
      <div className="flex justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono font-semibold text-foreground">{score !== undefined ? `${score}/100` : "—"}</span>
      </div>
      <Progress value={score ?? 0} className="h-1.5" />
    </div>
  );

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Evaluate &amp; Feedback</h1>
          <div className="bg-violet-500/20 text-violet-400 px-2 py-1 rounded text-xs font-bold tracking-widest flex items-center gap-1">
            <GraduationCap className="w-3 h-3" /> AI LECTURER
          </div>
        </div>
        <p className="text-muted-foreground mt-2">
          Upload a MIDI file and specify your stylistic goal. Amadeus extracts advanced musical features and generates personalised feedback from the AI Lecturer.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <Card className="bg-card border-border h-fit">
          <CardHeader>
            <CardTitle>Submit for Analysis</CardTitle>
            <CardDescription>The Lecturer evaluates your execution against your explicit intent.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium leading-none">Target Genre / Style</label>
                <Input 
                  placeholder="e.g., Cinematic Sci-Fi, Bebop Jazz, Classical Piano..." 
                  value={targetGenre}
                  onChange={(e) => setTargetGenre(e.target.value)}
                  disabled={isPending}
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium leading-none">MIDI File</label>
                <MidiFileUpload
                  selectedFile={selectedFile}
                  onFileSelect={(f) => { setSelectedFile(f); setFormError(null); }}
                  disabled={isPending}
                />
              </div>
            </div>

            {formError && <p className="text-sm font-medium text-destructive">{formError}</p>}
            
            <Button onClick={handleSubmit} disabled={isPending} className="w-full" data-testid="button-submit">
              {uploadMutation.isPending ? "Uploading..." : evaluateMutation.isPending ? "Submitting..." : "Evaluate Composition"}
            </Button>

            <div className="space-y-2 text-xs text-muted-foreground border-t border-border pt-4">
              <p className="font-medium text-foreground text-sm">What happens</p>
              <div className="flex items-start gap-2">
                <Target className="w-3 h-3 mt-0.5 shrink-0 text-primary" />
                <span>Your target genre anchors the evaluation context</span>
              </div>
              <div className="flex items-start gap-2">
                <Cpu className="w-3 h-3 mt-0.5 shrink-0 text-primary" />
                <span>Local feature extraction — polyphony, velocity variance, pitch range</span>
              </div>
              <div className="flex items-start gap-2">
                <GraduationCap className="w-3 h-3 mt-0.5 shrink-0 text-violet-400" />
                <span>Gemini generates feedback based on how well the math aligns with your intent</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {currentJobId && (
          <div className="space-y-6">
            <Card className="bg-card border-border">
              <CardHeader className="pb-3 border-b border-border">
                <div className="flex items-center justify-between">
                  <CardTitle>Analysis Report</CardTitle>
                  <JobStatusBadge status={job?.status ?? "pending"} />
                </div>
              </CardHeader>
              <CardContent className="pt-6 space-y-8">
                {!job ? (
                  <div className="text-sm text-muted-foreground">Loading...</div>
                ) : job.status === "failed" ? (
                  <div className="p-3 text-sm text-red-500 bg-red-500/10 rounded-md border border-red-500/20">
                    {job.errorMessage ?? "Analysis failed."}
                  </div>
                ) : job.status === "completed" && result ? (
                  <div className="space-y-8 animate-in fade-in duration-700">

                    {/* Overall score + genre */}
                    <div className="grid grid-cols-2 gap-4">
                      <div className="p-4 bg-primary/10 border border-primary/20 rounded-lg text-center">
                        <div className="text-xs text-primary uppercase tracking-wider font-medium mb-1">Overall Score</div>
                        <div className="text-5xl font-bold text-primary tracking-tighter" data-testid="score-overall">
                          {result.overallScore}
                        </div>
                      </div>
                      {result.predictedGenre && (
                        <div className="p-4 bg-violet-500/10 border border-violet-500/20 rounded-lg text-center">
                          <div className="text-xs text-violet-400 uppercase tracking-wider font-medium mb-1">Target Style</div>
                          <div className="text-xl font-bold text-violet-300 mt-1 line-clamp-2">{result.predictedGenre}</div>
                        </div>
                      )}
                    </div>

                    {/* MIDI features */}
                    {result.midiFeatures && (
                      <div className="space-y-2">
                        <h4 className="text-sm font-medium border-b border-border pb-2 flex items-center gap-2">
                          <Cpu className="w-3.5 h-3.5 text-primary" /> Extracted Features
                        </h4>
                        <div className="grid grid-cols-2 gap-2 text-sm">
                          {[
                            ["Tempo", `${result.midiFeatures.estimatedTempo} BPM`],
                            ["Polyphony (Max)", result.midiFeatures.maxPolyphony],
                            ["Note Density", `${result.midiFeatures.notesPerSecond}/sec`],
                            ["Dyn. Variance", result.midiFeatures.velocityVariance],
                            ["Pitch Range", `${result.midiFeatures.pitchRange} steps`],
                            ["Duration", `${result.midiFeatures.durationSeconds}s`],
                          ].map(([label, val]) => (
                            <div key={label as string} className="flex justify-between bg-secondary/30 rounded px-3 py-2">
                              <span className="text-muted-foreground">{label}</span>
                              <span className="font-mono font-medium">{val}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Lecturer feedback */}
                    {result.lecturerFeedback && (
                      <div className="space-y-3">
                        <h4 className="text-sm font-medium border-b border-border pb-2 flex items-center gap-2">
                          <GraduationCap className="w-3.5 h-3.5 text-violet-400" /> Lecturer Feedback
                        </h4>
                        <div className="p-4 bg-violet-500/8 border border-violet-500/20 rounded-lg relative">
                          <div className="absolute top-3 left-3 text-violet-300 opacity-30 text-4xl font-serif leading-none">"</div>
                          <p className="text-sm text-foreground leading-relaxed pl-4 italic">
                            {result.lecturerFeedback}
                          </p>
                          <div className="absolute bottom-3 right-4 text-violet-300 opacity-30 text-4xl font-serif leading-none">"</div>
                        </div>
                        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-violet-400 inline-block" />
                          Generated by Gemini · Amadeus AI Lecturer
                        </p>
                      </div>
                    )}

                  </div>
                ) : (
                  <div className="py-8 flex flex-col items-center justify-center text-muted-foreground gap-4">
                    <div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                    <div className="text-center">
                      <p className="text-sm font-medium text-foreground">
                        {job.status === "pending" ? "Queued..." : "Analysing your composition..."}
                      </p>
                      <p className="text-xs mt-1">Extracting features → Generating feedback</p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}