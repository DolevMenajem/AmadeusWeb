import { useState } from "react";
import {
  useEvaluateMidi,
  useUploadMidiFile,
  getListJobsQueryKey,
  getGetStatsQueryKey,
  useGetJob,
  getGetJobQueryKey,
  useListJobs
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
import { Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer, Tooltip } from 'recharts';
import { useLocalStorage } from "@/hooks/use-local-storage";
import { InlineEdit } from "@/components/inline-edit";

export default function Evaluate() {
  const [currentJobId, setCurrentJobId] = useLocalStorage<number | null>("amadeus_evaluate_job_id", null);  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [targetGenre, setTargetGenre] = useState<string>("");
  const [formError, setFormError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"Theory & Harmony" | "Rhythm & Groove" | "Genre Accuracy">("Theory & Harmony");

  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: allJobs } = useListJobs();
  const evaluationHistory = allJobs?.filter((j: any) => j.type === "evaluate" && j.status === "completed") || [];

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
        {/* LEFT COLUMN WRAPPER */}
        <div className="space-y-6">
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

          {/* NEW: Evaluation History Card */}
          <Card className="bg-card border-border h-fit">
            <CardHeader>
              <CardTitle className="text-lg">Evaluation History</CardTitle>
              <CardDescription>Click to instantly load a past analysis.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 max-h-[300px] overflow-y-auto pr-2">
                {evaluationHistory.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No past evaluations found.</p>
                ) : (
                  evaluationHistory.map((pastJob: any) => (
                    <div 
                      key={pastJob.id}
                      className={`w-full flex items-center justify-between p-2 rounded-md border text-sm transition-colors ${
                        currentJobId === pastJob.id 
                          ? "bg-primary text-primary-foreground border-primary" 
                          : "bg-background border-input hover:bg-accent hover:text-accent-foreground"
                      }`}
                    >
                      {/* Clicking the container selects the job */}
                      <div 
                        className="truncate flex-1 flex items-center gap-2 cursor-pointer" 
                        onClick={() => setCurrentJobId(pastJob.id)}
                      >
                        <InlineEdit jobId={pastJob.id} initialValue={pastJob.inputFilename} />
                      </div>
                      
                      <span 
                        className="ml-2 text-xs opacity-50 shrink-0 cursor-pointer"
                        onClick={() => setCurrentJobId(pastJob.id)}
                      >
                        {pastJob.targetGenre || "General"}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </div>
        {/* END LEFT COLUMN WRAPPER */}

        {currentJobId && (
          <div className="space-y-6">
            <Card className="bg-card border-border">
              <CardHeader className="pb-3 border-b border-border">
                <div className="flex items-center justify-between">
                  <CardTitle>Analysis Report</CardTitle>
                  
                  <div className="flex items-center gap-3">
                    <JobStatusBadge status={job?.status ?? "pending"} />
                    
                    {/* NEW: Background / Clear Button */}
                    <Button 
                      variant="outline" 
                      size="sm"
                      className="h-7 text-xs"
                      onClick={() => setCurrentJobId(null)}
                      title="Clear this view to start a new job. This job will continue in the background."
                    >
                      New Job
                    </Button>

                    {/* ONLY SHOW CANCEL BUTTON IF IT IS PENDING OR PROCESSING */}
                    {(job?.status === "pending" || job?.status === "processing") && (
                      <Button 
                        variant="destructive" 
                        size="sm"
                        className="h-7 text-xs"
                        onClick={async () => {
                          try {
                            await fetch(`/api/jobs/${currentJobId}/cancel`, { method: "POST" });
                            queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(currentJobId as number) });
                            queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
                          } catch (e) {
                            console.error("Failed to cancel job", e);
                          }
                        }}
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
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

                    {/* Overall score & Radar Chart */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="flex flex-col gap-4">
                        <div className="p-4 bg-primary/10 border border-primary/20 rounded-lg text-center flex-1 flex flex-col justify-center">
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

                     <div className="h-[250px] w-full bg-secondary/10 border border-border rounded-lg p-2 flex items-center justify-center">
                        <ResponsiveContainer width="100%" height="100%">
                          <RadarChart 
                            cx="50%"
                            cy="50%"
                            outerRadius="55%"
                            data={[
                              { subject: 'Theory', score: result.theoryScore || 0, fullMark: 100 },
                              { subject: 'Rhythm', score: result.rhythmScore || 0, fullMark: 100 },
                              { subject: 'Genre', score: result.genreScore || 0, fullMark: 100 },
                              { subject: 'Overall', score: result.overallScore || 0, fullMark: 100 }
                            ]}
                          >
                            <PolarGrid stroke="rgba(255,255,255,0.1)" />
                            <PolarAngleAxis dataKey="subject" tick={{ fill: 'rgba(255,255,255,0.6)', fontSize: 12 }} />
                            <PolarRadiusAxis angle={30} domain={[0, 100]} tick={false} axisLine={false} />
                            <Radar name="Score" dataKey="score" stroke="#8b5cf6" fill="#8b5cf6" fillOpacity={0.4} />
                            <Tooltip contentStyle={{ backgroundColor: '#18181b', borderColor: '#27272a' }} itemStyle={{ color: '#a78bfa' }} />
                          </RadarChart>
                        </ResponsiveContainer>
                      </div>
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

                    {/* Lecturer feedback - Multi-Lens Carousel */}
                    {result.lecturerFeedback && typeof result.lecturerFeedback === 'object' && (
                      <div className="space-y-4">
                        <div className="flex gap-2 border-b border-border pb-2">
                          {["Theory & Harmony", "Rhythm & Groove", "Genre Accuracy"].map((tab) => (
                            <Button
                              key={tab}
                              variant={activeTab === tab ? "default" : "ghost"}
                              size="sm"
                              onClick={() => setActiveTab(tab as any)}
                              className={activeTab === tab ? "bg-violet-500 text-white hover:bg-violet-600" : "text-muted-foreground"}
                            >
                              {tab}
                            </Button>
                          ))}
                        </div>

                        <div className="p-4 bg-violet-500/8 border border-violet-500/20 rounded-lg relative min-h-[120px]">
                          <div className="absolute top-3 left-3 text-violet-300 opacity-30 text-4xl font-serif leading-none">"</div>
                          <p className="text-sm text-foreground leading-relaxed pl-4 italic">
                            {result.lecturerFeedback[activeTab] || "Analyzing this specific aspect..."}
                          </p>
                          <div className="absolute bottom-3 right-4 text-violet-300 opacity-30 text-4xl font-serif leading-none">"</div>
                        </div>

                        {/* Suggestions Box (Displaying the top 3 from the pooled array) */}
                        {result.suggestions && result.suggestions.length > 0 && (
                           <div className="mt-4 p-3 bg-secondary/30 rounded-lg border border-border">
                             <h5 className="text-xs font-semibold uppercase tracking-wider mb-2">Key Suggestions</h5>
                             <ul className="list-disc pl-4 space-y-1 text-sm text-muted-foreground">
                               {result.suggestions.slice(0, 3).map((suggestion: string, idx: number) => (
                                 <li key={idx}>{suggestion}</li>
                               ))}
                             </ul>
                           </div>
                        )}

                        <p className="text-xs text-muted-foreground flex items-center gap-1.5 pt-2">
                          <span className="w-2 h-2 rounded-full bg-violet-400 inline-block" />
                          Generated concurrently by Gemini · Amadeus AI Lecturer
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