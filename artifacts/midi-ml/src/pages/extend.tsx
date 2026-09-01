import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  useExtendMidi,
  useUploadMidiFile,
  getListJobsQueryKey,
  getGetStatsQueryKey,
  useGetJob,
  getGetJobQueryKey,
  useDownloadJobResult,
  getDownloadJobResultQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

// UI Components
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { JobStatusBadge } from "@/components/job-status-badge";
import { MidiFileUpload } from "@/components/midi-file-upload";
import { MidiVisualizer } from  "@/components/midi-visualizer";
import { InlineEdit } from "@/components/inline-edit";

// Hooks & Icons
import { useToast } from "@/hooks/use-toast";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { Download, BrainCircuit, Sparkles, Settings2, FileMusic } from "lucide-react";

// --- VALIDATION SCHEMA ---
// Defines the strict shapes and boundaries of our form data using Zod
const formSchema = z.object({
  barsToExtend: z.number().min(1).max(64),
  temperature: z.number().min(0.1).max(2.0),
  topK: z.number().min(0).max(100),
  topP: z.number().min(0.1).max(1.0),
  modelType: z.enum(["remi", "octuple", "tsd"]),
});

export default function Extend() {
  // --- STATE MANAGEMENT ---
  // Using localStorage ensures the job keeps polling even if the user navigates away and comes back
  const [currentJobId, setCurrentJobId] = useLocalStorage<number | null>("amadeus_extend_job_id", null); 
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [audioEl, setAudioEl] = useState<HTMLAudioElement | null>(null);
  
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // --- API QUERIES & MUTATIONS ---
  const uploadMutation = useUploadMidiFile();

  const extendMutation = useExtendMidi({
    mutation: {
      onSuccess: (data) => {
        toast({ title: "Job submitted", description: "Your MIDI file is being extended." });
        setCurrentJobId(data.id);
        // Invalidate global stats so the Dashboard updates in the background
        queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetStatsQueryKey() });
      },
      onError: (err: any) => {
        toast({ title: "Submission failed", description: err.message || "Unknown error", variant: "destructive" });
      },
    },
  });

  // Polls the backend for job status. Stops polling automatically when not 'pending' or 'processing'
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

  const { data: downloadInfo } = useDownloadJobResult(currentJobId as number, {
    query: {
      enabled: !!currentJobId && job?.status === "completed",
      queryKey: getDownloadJobResultQueryKey(currentJobId as number),
    },
  });

  // --- FORM INITIALIZATION ---
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { barsToExtend: 8, temperature: 0.8, topK: 0, topP: 1.0, modelType: "remi" },
  });

  // --- SUBMIT HANDLER ---
  const onSubmit = (values: z.infer<typeof formSchema>) => {
    if (!selectedFile) { setFileError("Please select a MIDI file"); return; }
    setFileError(null);
    
    // Step 1: Upload the file
    uploadMutation.mutate({ data: { file: selectedFile } }, {
      onSuccess: (upload) => {
        // Step 2: Trigger the ML job with the uploaded filename
        extendMutation.mutate({ 
          data: { 
            inputFilename: upload.filename, 
            barsToExtend: values.barsToExtend,
            temperature: values.temperature ?? 0.8,
            topK: values.topK ?? 0,
            topP: values.topP ?? 1.0,
            modelType: values.modelType 
          } as any 
        });
      },
      onError: (err: any) => {
        toast({ title: "Upload failed", description: err.message || "Could not upload file", variant: "destructive" });
      },
    });
  };

  const isPending = uploadMutation.isPending || extendMutation.isPending;

  // --- RENDER ---
  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      
      {/* Page Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground flex items-center gap-3">
          Extend Composition <Sparkles className="w-8 h-8 text-primary opacity-80" />
        </h1>
        <p className="text-muted-foreground mt-2">Upload a seed track and let the PyTorch AI generate the next section.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        
        {/* LEFT COLUMN: Input Form */}
        {/* VISUALS: Upgraded to a sleek gradient card with a soft shadow */}
        <Card className="bg-gradient-to-br from-card to-background/50 border-border shadow-md shadow-black/20 h-fit">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Settings2 className="w-5 h-5 text-primary" /> Generation Settings</CardTitle>
            <CardDescription>Configure the neural network parameters for your extension.</CardDescription>
          </CardHeader>
          <CardContent>
            
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                
                {/* BLOCK 1: AI Architecture */}
                <FormField control={form.control} name="modelType" render={({ field }) => (
                  <FormItem className="p-4 bg-primary/5 border border-primary/20 rounded-lg shadow-sm transition-colors hover:border-primary/40">
                    <FormLabel className="text-base font-semibold text-primary flex items-center gap-2">
                      <BrainCircuit className="w-4 h-4" /> AI Architecture
                    </FormLabel>
                    <FormControl>
                      <select
                        {...field}
                        className="flex h-10 w-full rounded-md border border-input bg-background/50 backdrop-blur-sm px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <option value="remi">Standard Model (Single-Track / REMI)</option>
                        <option value="octuple">Multi-Track Model (Full Band / Octuple)</option>
                        <option value="tsd">Next-Gen GPT Model (Experimental / TSD)</option>
                      </select>
                    </FormControl>
                    <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                      {field.value === "remi" && "Generates a continuation for only the primary instrument."}
                      {field.value === "octuple" && "Generates a coordinated continuation for drums, bass, chords, and melody."}
                      {field.value === "tsd" && "Uses an advanced GPT-style transformer for high-fidelity timing generation."}
                    </p>
                    <FormMessage />
                  </FormItem>
                )} />

                {/* BLOCK 2: Seed File Upload */}
                <div className="space-y-3 p-4 bg-secondary/10 border border-border rounded-lg transition-colors hover:bg-secondary/20">
                  <label className="text-sm font-semibold flex items-center gap-2">
                    <FileMusic className="w-4 h-4 text-primary" /> Seed MIDI File
                  </label>
                  <MidiFileUpload
                    selectedFile={selectedFile}
                    onFileSelect={(f) => { setSelectedFile(f); setFileError(null); }}
                    disabled={isPending}
                  />
                  {fileError && <p className="text-sm font-medium text-destructive">{fileError}</p>}
                </div>

                {/* BLOCK 3: Generation Parameters (Sliders) */}
                <div className="space-y-5 p-4 bg-secondary/5 border border-border rounded-lg">
                  <FormField control={form.control} name="barsToExtend" render={({ field }) => (
                    <FormItem className="group">
                      <FormLabel className="flex justify-between">
                        <span className="font-medium group-hover:text-primary transition-colors">Bars to Extend</span>
                        <span className="text-primary font-mono bg-primary/10 px-2 py-0.5 rounded">{field.value ?? 8}</span>
                      </FormLabel>
                      <FormControl><Slider min={1} max={64} step={1} value={[field.value ?? 8]} onValueChange={(vals) => field.onChange(vals[0])} className="py-2" /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />

                  <FormField control={form.control} name="temperature" render={({ field }) => (
                    <FormItem className="group">
                      <FormLabel className="flex justify-between">
                        <span className="font-medium group-hover:text-primary transition-colors">Temperature (Creativity)</span>
                        <span className="text-primary font-mono bg-primary/10 px-2 py-0.5 rounded">{Number(field.value ?? 0.8).toFixed(2)}</span>
                      </FormLabel>
                      <FormControl><Slider min={0.1} max={2.0} step={0.1} value={[field.value ?? 0.8]} onValueChange={(vals) => field.onChange(vals[0])} className="py-2" /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />

                  <div className="grid grid-cols-2 gap-6 pt-2">
                    <FormField control={form.control} name="topK" render={({ field }) => (
                      <FormItem className="group">
                        <FormLabel className="flex justify-between">
                          <span className="font-medium group-hover:text-primary transition-colors">Top-K</span>
                          <span className="text-primary font-mono bg-primary/10 px-2 py-0.5 rounded">{field.value ?? 0}</span>
                        </FormLabel>
                        <FormControl><Slider min={0} max={100} step={1} value={[field.value ?? 0]} onValueChange={(vals) => field.onChange(vals[0])} className="py-2" /></FormControl>
                        <p className="text-[10px] text-muted-foreground leading-tight mt-1">Limits AI to K likely notes (0 disables).</p>
                      </FormItem>
                    )} />
                    
                    <FormField control={form.control} name="topP" render={({ field }) => (
                      <FormItem className="group">
                        <FormLabel className="flex justify-between">
                          <span className="font-medium group-hover:text-primary transition-colors">Top-P</span>
                          <span className="text-primary font-mono bg-primary/10 px-2 py-0.5 rounded">{Number(field.value ?? 1.0).toFixed(2)}</span>
                        </FormLabel>
                        <FormControl><Slider min={0.1} max={1.0} step={0.05} value={[field.value ?? 1.0]} onValueChange={(vals) => field.onChange(vals[0])} className="py-2" /></FormControl>
                        <p className="text-[10px] text-muted-foreground leading-tight mt-1">Dynamically filters unlikely notes.</p>
                      </FormItem>
                    )} />
                  </div>
                </div>

                {/* Submit Button */}
                <Button 
                  type="submit" 
                  disabled={isPending} 
                  className="w-full h-12 text-md shadow-md shadow-primary/20 hover:shadow-primary/40 transition-all gap-2"
                >
                  {uploadMutation.isPending ? "Uploading..." : extendMutation.isPending ? "Submitting..." : <><BrainCircuit className="w-5 h-5" /> Generate Extension</>}
                </Button>
              </form>
            </Form>

          </CardContent>
        </Card>

        {/* RIGHT COLUMN: Results Display */}
        {currentJobId && (
          <Card className="bg-gradient-to-br from-card to-background/50 border-primary/30 shadow-lg shadow-primary/5 h-fit ring-1 ring-primary/20 animate-in fade-in slide-in-from-right-4">
            <CardHeader className="pb-3 border-b border-border bg-secondary/10 rounded-t-xl">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-primary" /> Result
                </CardTitle>

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
            <CardContent className="pt-6 space-y-6">
              
              {!job ? (
                <div className="text-sm text-muted-foreground flex items-center justify-center py-12">Loading job data...</div>
              ) : (
                <>
                  {/* Job Metadata */}
                  <div className="space-y-4 bg-secondary/10 p-4 rounded-lg border border-border/50">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">File</span>
                      <InlineEdit jobId={job.id} initialValue={job.inputFilename} />
                    </div>
                    {job.barsToExtend && (
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Extension Length</span>
                        <span className="font-medium bg-primary/10 text-primary px-2 py-0.5 rounded">{job.barsToExtend} bars</span>
                      </div>
                    )}
                  </div>

                  {/* Processing State */}
                  {(job.status === "pending" || job.status === "processing") && (
                    <div className="py-12 flex flex-col items-center gap-4 text-muted-foreground">
                      <div className="w-8 h-8 rounded-full border-2 border-primary/50 border-t-primary animate-spin" />
                      <p className="text-sm font-medium">{job.status === "pending" ? "Queued in backend..." : "Neural network is extending your piece..."}</p>
                    </div>
                  )}

                  {/* Error State */}
                  {job.status === "failed" && (
                    <div className="p-4 text-sm text-destructive bg-destructive/10 rounded-md border border-destructive/20 flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-destructive animate-pulse" />
                      {job.errorMessage || "An unknown error occurred during generation."}
                    </div>
                  )}

                  {/* Success State */}
                  {job.status === "completed" && (
                    <div className="space-y-6 pt-2 animate-in fade-in slide-in-from-bottom-2 duration-700">
                      
                      {/* Audio Player & Visualizer */}
                      <div className="space-y-4 bg-secondary/20 p-5 rounded-lg border border-border shadow-inner">
                        <h4 className="text-sm font-semibold flex items-center justify-center gap-2">
                          <BrainCircuit className="w-4 h-4 text-primary" /> AI Studio Render
                        </h4>

                        <div className="mb-2 ring-1 ring-border rounded-lg overflow-hidden bg-black/20">
                          <MidiVisualizer 
                            midiUrl={`/api/jobs/${job.id}/download?type=full`} 
                            inputMidiUrl={`/api/jobs/${job.id}/download?type=input`}
                            audioElement={audioEl} 
                          />
                        </div>

                        <audio 
                          ref={setAudioEl}
                          controls 
                          className="w-full h-10 rounded-md shadow-sm" 
                          src={`/api/jobs/${job.id}/download?type=audio`}
                          controlsList="nodownload"
                        >
                          Your browser does not support the audio element.
                        </audio>
                      </div>

                      {/* Download Actions */}
                      <div className="grid grid-cols-2 gap-3 pt-2">
                        <Button asChild variant="default" className="w-full gap-2 shadow-sm shadow-primary/20 hover:shadow-primary/40">
                          <a href={`/api/jobs/${job.id}/download?type=full`} download>
                            <Download className="w-4 h-4" /> Full Song
                          </a>
                        </Button>
                        <Button asChild variant="outline" className="w-full gap-2 hover:bg-primary/5 hover:text-primary">
                          <a href={`/api/jobs/${job.id}/download?type=extension`} download>
                            <Download className="w-4 h-4" /> Extension Only
                          </a>
                        </Button>
                      </div>
                      
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}