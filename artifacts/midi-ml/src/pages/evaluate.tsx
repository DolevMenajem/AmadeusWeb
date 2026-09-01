import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useEvaluateMidi,
  useUploadMidiFile,
  getListJobsQueryKey,
  getGetStatsQueryKey,
  useGetJob,
  getGetJobQueryKey,
  useListJobs
} from "@workspace/api-client-react";

// UI Components
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { JobStatusBadge } from "@/components/job-status-badge";
import { MidiFileUpload } from "@/components/midi-file-upload";
import { InlineEdit } from "@/components/inline-edit";
import { Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer, Tooltip } from 'recharts';

// Hooks & Icons
import { useToast } from "@/hooks/use-toast";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { GraduationCap, Cpu, Target, FileMusic, Sparkles, BookOpen } from "lucide-react";

export default function Evaluate() {
  // --- STATE MANAGEMENT ---
  const [currentJobId, setCurrentJobId] = useLocalStorage<number | null>("amadeus_evaluate_job_id", null); 
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [targetGenre, setTargetGenre] = useState<string>("");
  const [formError, setFormError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"Theory & Harmony" | "Rhythm & Groove" | "Genre Accuracy">("Theory & Harmony");

  const { toast } = useToast();
  const queryClient = useQueryClient();

  // --- API QUERIES & MUTATIONS ---
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

  // --- SUBMIT HANDLER ---
  const handleSubmit = () => {
    if (!targetGenre.trim()) { setFormError("Please specify your target genre."); return; }
    if (!selectedFile) { setFormError("Please select a MIDI file."); return; }
    
    setFormError(null);
    uploadMutation.mutate(
      { data: { file: selectedFile } },
      {
        onSuccess: (upload) => {
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

  // --- RENDER ---
  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      
      {/* Page Header */}
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-bold tracking-tight text-foreground flex items-center gap-3">
            Evaluate &amp; Feedback
            <GraduationCap className="w-8 h-8 text-violet-500 opacity-80" />
          </h1>
          {/* VISUALS: Enhanced the AI Lecturer badge for better contrast */}
          <div className="bg-violet-500/20 border border-violet-500/30 text-violet-400 px-2 py-1 rounded-md text-xs font-bold tracking-widest flex items-center gap-1.5 shadow-sm">
            <Sparkles className="w-3 h-3" /> AI LECTURER
          </div>
        </div>
        <p className="text-muted-foreground mt-2">
          Upload a MIDI file and specify your stylistic goal. Amadeus extracts advanced musical features and generates personalised feedback from the AI Lecturer.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        
        {/* LEFT COLUMN: Inputs & History */}
        <div className="space-y-6">
          
          {/* Submit Card */}
          <Card className="bg-gradient-to-br from-card to-background/50 border-border shadow-md shadow-black/20 h-fit">
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><BookOpen className="w-5 h-5 text-violet-400" /> Submit for Analysis</CardTitle>
              <CardDescription>The Lecturer evaluates your execution against your explicit intent.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              
              <div className="space-y-5">
                {/* Genre Input */}
                <div className="space-y-2">
                  <label className="text-sm font-semibold flex items-center gap-2">Target Genre / Style</label>
                  <Input 
                    placeholder="e.g., Cinematic Sci-Fi, Bebop Jazz, Classical Piano..." 
                    value={targetGenre}
                    onChange={(e) => setTargetGenre(e.target.value)}
                    disabled={isPending}
                    className="bg-background/50 backdrop-blur-sm border-input transition-colors focus:border-violet-500"
                  />
                </div>

                {/* File Upload Dropzone */}
                <div className="space-y-2 p-4 bg-secondary/10 border border-border rounded-lg transition-colors hover:bg-secondary/20">
                  <label className="text-sm font-semibold flex items-center gap-2">
                    <FileMusic className="w-4 h-4 text-violet-400" /> MIDI File
                  </label>
                  <MidiFileUpload
                    selectedFile={selectedFile}
                    onFileSelect={(f) => { setSelectedFile(f); setFormError(null); }}
                    disabled={isPending}
                  />
                </div>
              </div>

              {formError && <p className="text-sm font-medium text-destructive">{formError}</p>}
              
              {/* Submit Button */}
              <Button 
                onClick={handleSubmit} 
                disabled={isPending} 
                className="w-full h-12 text-md shadow-md shadow-violet-500/20 hover:shadow-violet-500/40 hover:bg-violet-600 transition-all gap-2 bg-violet-500 text-white" 
                data-testid="button-submit"
              >
                {uploadMutation.isPending ? "Uploading..." : evaluateMutation.isPending ? "Submitting..." : <><GraduationCap className="w-5 h-5" /> Evaluate Composition</>}
              </Button>

              {/* Informational Block */}
              <div className="space-y-3 p-4 bg-secondary/20 rounded-lg border border-border/50 text-xs text-muted-foreground mt-4">
                <p className="font-semibold text-foreground text-sm flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-violet-400" /> Analysis Pipeline
                </p>
                <div className="flex items-start gap-2">
                  <Target className="w-3.5 h-3.5 mt-0.5 shrink-0 text-violet-400" />
                  <span>Your target genre anchors the evaluation context.</span>
                </div>
                <div className="flex items-start gap-2">
                  <Cpu className="w-3.5 h-3.5 mt-0.5 shrink-0 text-violet-400" />
                  <span>Local feature extraction — polyphony, velocity variance, pitch range.</span>
                </div>
                <div className="flex items-start gap-2">
                  <GraduationCap className="w-3.5 h-3.5 mt-0.5 shrink-0 text-violet-400" />
                  <span>Gemini generates feedback based on how well the math aligns with your intent.</span>
                </div>
              </div>

            </CardContent>
          </Card>

          {/* History Card */}
          <Card className="bg-gradient-to-br from-card to-background/50 border-border shadow-md shadow-black/20 h-fit">
            <CardHeader className="pb-3 border-b border-border bg-secondary/5 rounded-t-xl">
              <CardTitle className="text-lg">Evaluation History</CardTitle>
              <CardDescription>Click to instantly load a past analysis.</CardDescription>
            </CardHeader>
            <CardContent className="pt-4">
              <div className="space-y-2 max-h-[250px] overflow-y-auto pr-2 custom-scrollbar">
                {evaluationHistory.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">No past evaluations found.</p>
                ) : (
                  evaluationHistory.map((pastJob: any) => (
                    <div 
                      key={pastJob.id}
                      className={`w-full flex items-center justify-between p-2 rounded-md border text-sm transition-all ${
                        currentJobId === pastJob.id 
                          ? "bg-violet-500/20 text-violet-100 border-violet-500/50 shadow-sm shadow-violet-500/10" 
                          : "bg-background/50 border-input hover:bg-secondary/40 hover:border-border cursor-pointer"
                      }`}
                      onClick={(e) => {
                        // Prevent row click if they are interacting with the InlineEdit
                        if ((e.target as HTMLElement).closest('.inline-edit-container')) return;
                        setCurrentJobId(pastJob.id);
                      }}
                    >
                      <div className="truncate flex-1 flex items-center gap-2 inline-edit-container">
                        <InlineEdit jobId={pastJob.id} initialValue={pastJob.inputFilename} />
                      </div>
                      
                      <span className="ml-2 text-xs font-medium opacity-60 shrink-0 bg-background/50 px-2 py-0.5 rounded">
                        {pastJob.targetGenre || "General"}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* RIGHT COLUMN: Results Display */}
        {currentJobId && (
          <div className="space-y-6">
            <Card className="bg-gradient-to-br from-card to-background/50 border-violet-500/30 shadow-lg shadow-violet-500/10 h-fit ring-1 ring-violet-500/20 animate-in fade-in slide-in-from-right-4">
              <CardHeader className="pb-3 border-b border-border bg-secondary/10 rounded-t-xl">
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2"><Target className="w-5 h-5 text-violet-400" /> Analysis Report</CardTitle>
                  
                  <div className="flex items-center gap-3">
                    <JobStatusBadge status={job?.status ?? "pending"} />
                    
                    <Button 
                      variant="outline" 
                      size="sm"
                      className="h-7 text-xs bg-background/50 hover:bg-background"
                      onClick={() => setCurrentJobId(null)}
                      title="Clear this view to start a new job. This job will continue in the background."
                    >
                      New Job
                    </Button>

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
                
                {/* Loading State */}
                {!job ? (
                  <div className="text-sm text-muted-foreground flex items-center justify-center py-12">Loading analysis data...</div>
                ) : job.status === "failed" ? (
                  <div className="p-4 text-sm text-destructive bg-destructive/10 rounded-md border border-destructive/20 flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-destructive animate-pulse" />
                    {job.errorMessage ?? "Analysis failed."}
                  </div>
                ) : job.status === "completed" && result ? (
                  <div className="space-y-8 animate-in fade-in duration-700">

                    {/* Overall Score & Radar Chart */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      
                      {/* Score Boxes */}
                      <div className="flex flex-col gap-4">
                        <div className="p-6 bg-gradient-to-br from-violet-500/20 to-violet-500/5 border border-violet-500/30 rounded-lg text-center flex-1 flex flex-col justify-center shadow-inner">
                          <div className="text-xs text-violet-400 uppercase tracking-widest font-bold mb-2">Overall Score</div>
                          <div className="text-6xl font-black text-violet-100 tracking-tighter drop-shadow-md" data-testid="score-overall">
                            {result.overallScore}
                          </div>
                        </div>
                        {result.predictedGenre && (
                          <div className="p-4 bg-secondary/30 border border-border/50 rounded-lg text-center shadow-sm">
                            <div className="text-xs text-muted-foreground uppercase tracking-widest font-semibold mb-1">Target Style</div>
                            <div className="text-lg font-bold text-foreground mt-1 line-clamp-2">{result.predictedGenre}</div>
                          </div>
                        )}
                      </div>

                      {/* Radar Chart */}
                      <div className="h-[250px] w-full bg-black/40 border border-border/50 rounded-lg p-2 flex items-center justify-center shadow-inner relative overflow-hidden">
                        {/* Decorative background glow for the chart */}
                        <div className="absolute inset-0 bg-violet-500/5 rounded-lg pointer-events-none blur-xl"></div>
                        <ResponsiveContainer width="100%" height="100%" className="relative z-10">
                          <RadarChart 
                            cx="50%"
                            cy="50%"
                            outerRadius="60%"
                            data={[
                              { subject: 'Theory', score: result.theoryScore || 0, fullMark: 100 },
                              { subject: 'Rhythm', score: result.rhythmScore || 0, fullMark: 100 },
                              { subject: 'Genre', score: result.genreScore || 0, fullMark: 100 },
                              { subject: 'Overall', score: result.overallScore || 0, fullMark: 100 }
                            ]}
                          >
                            <PolarGrid stroke="rgba(139, 92, 246, 0.2)" />
                            <PolarAngleAxis dataKey="subject" tick={{ fill: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: 600 }} />
                            <PolarRadiusAxis angle={30} domain={[0, 100]} tick={false} axisLine={false} />
                            <Radar name="Score" dataKey="score" stroke="#8b5cf6" strokeWidth={2} fill="#8b5cf6" fillOpacity={0.4} />
                            <Tooltip 
                              contentStyle={{ backgroundColor: '#18181b', borderColor: '#8b5cf6', borderRadius: '8px', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.5)' }} 
                              itemStyle={{ color: '#c4b5fd', fontWeight: 'bold' }} 
                            />
                          </RadarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>

                    {/* MIDI Features */}
                    {result.midiFeatures && (
                      <div className="space-y-3 bg-secondary/10 p-4 rounded-lg border border-border/50">
                        <h4 className="text-sm font-semibold border-b border-border/50 pb-2 flex items-center gap-2">
                          <Cpu className="w-4 h-4 text-violet-400" /> Extracted Mathematical Features
                        </h4>
                        <div className="grid grid-cols-2 gap-3 text-sm pt-1">
                          {[
                            ["Tempo", `${result.midiFeatures.estimatedTempo} BPM`],
                            ["Polyphony (Max)", result.midiFeatures.maxPolyphony],
                            ["Note Density", `${result.midiFeatures.notesPerSecond}/sec`],
                            ["Dyn. Variance", result.midiFeatures.velocityVariance],
                            ["Pitch Range", `${result.midiFeatures.pitchRange} steps`],
                            ["Duration", `${result.midiFeatures.durationSeconds}s`],
                          ].map(([label, val]) => (
                            <div key={label as string} className="flex justify-between items-center bg-background/50 rounded-md px-3 py-2 border border-border/30">
                              <span className="text-muted-foreground text-xs">{label}</span>
                              <span className="font-mono font-semibold text-violet-100">{val}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Lecturer Feedback - Multi-Lens Carousel */}
                    {result.lecturerFeedback && typeof result.lecturerFeedback === 'object' && (
                      <div className="space-y-4">
                        
                        {/* Tab Navigation */}
                        <div className="flex gap-2 border-b border-border/50 pb-3 overflow-x-auto custom-scrollbar">
                          {["Theory & Harmony", "Rhythm & Groove", "Genre Accuracy"].map((tab) => (
                            <Button
                              key={tab}
                              variant={activeTab === tab ? "default" : "ghost"}
                              size="sm"
                              onClick={() => setActiveTab(tab as any)}
                              className={`transition-all whitespace-nowrap ${
                                activeTab === tab 
                                  ? "bg-violet-500 text-white shadow-md shadow-violet-500/20" 
                                  : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                              }`}
                            >
                              {tab}
                            </Button>
                          ))}
                        </div>

                        {/* Feedback Quote Block */}
                        <div className="p-5 bg-gradient-to-br from-violet-900/20 to-transparent border border-violet-500/20 rounded-xl relative min-h-[140px] shadow-inner">
                          <div className="absolute top-4 left-4 text-violet-500/20 text-6xl font-serif leading-none">"</div>
                          <p className="text-sm text-foreground/90 leading-relaxed pl-6 pt-2 italic relative z-10">
                            {result.lecturerFeedback[activeTab] || "Analyzing this specific aspect..."}
                          </p>
                          <div className="absolute bottom-[-10px] right-6 text-violet-500/20 text-6xl font-serif leading-none">"</div>
                        </div>

                        {/* Suggestions Box */}
                        {result.suggestions && result.suggestions.length > 0 && (
                           <div className="mt-4 p-4 bg-secondary/30 rounded-xl border border-border/50">
                             <h5 className="text-xs font-bold uppercase tracking-widest mb-3 flex items-center gap-2 text-violet-400">
                               <Sparkles className="w-3.5 h-3.5" /> Key Suggestions
                             </h5>
                             <ul className="pl-5 space-y-2 text-sm text-foreground/80 marker:text-violet-500">
                               {result.suggestions.slice(0, 3).map((suggestion: string, idx: number) => (
                                 <li key={idx} className="leading-relaxed">{suggestion}</li>
                               ))}
                             </ul>
                           </div>
                        )}

                        {/* Footer Watermark */}
                        <p className="text-xs text-muted-foreground flex items-center justify-end gap-1.5 pt-4">
                          <span className="w-2 h-2 rounded-full bg-violet-500 inline-block animate-pulse" />
                          Generated by Gemini 2.5 Flash · Amadeus Evaluator
                        </p>
                      </div>
                    )}

                  </div>
                ) : (
                  <div className="py-16 flex flex-col items-center justify-center text-muted-foreground gap-5">
                    <div className="relative flex items-center justify-center">
                      <div className="absolute w-12 h-12 rounded-full border-4 border-violet-500/20"></div>
                      <div className="w-12 h-12 rounded-full border-4 border-violet-500 border-t-transparent animate-spin"></div>
                    </div>
                    <div className="text-center">
                      <p className="text-sm font-semibold text-foreground">
                        {job.status === "pending" ? "Queued in processing pipeline..." : "Lecturer is analysing your composition..."}
                      </p>
                      <p className="text-xs mt-1.5 opacity-70">Extracting features → Generating feedback</p>
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