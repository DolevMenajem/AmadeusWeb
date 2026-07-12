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
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { JobStatusBadge } from "@/components/job-status-badge";
import { Slider } from "@/components/ui/slider";
import { MidiFileUpload } from "@/components/midi-file-upload";
import { MidiPlayer } from "@/components/midi-player";
import { Download, BrainCircuit, AudioLines } from "lucide-react";
import { MidiVisualizer } from  "@/components/midi-visualizer";

// 1. ADDED modelType TO THE SCHEMA
const formSchema = z.object({
  barsToExtend: z.number().min(1).max(64),
  temperature: z.number().min(0.1).max(2.0),
  topK: z.number().min(0).max(100),
  topP: z.number().min(0.1).max(1.0),
  modelType: z.enum(["remi", "octuple"]),
});

export default function Extend() {
  const [currentJobId, setCurrentJobId] = useState<number | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [audioEl, setAudioEl] = useState<HTMLAudioElement | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const uploadMutation = useUploadMidiFile();

  const extendMutation = useExtendMidi({
    mutation: {
      onSuccess: (data) => {
        toast({ title: "Job submitted", description: "Your MIDI file is being extended." });
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

  const { data: downloadInfo } = useDownloadJobResult(currentJobId as number, {
    query: {
      enabled: !!currentJobId && job?.status === "completed",
      queryKey: getDownloadJobResultQueryKey(currentJobId as number),
    },
  });

  // 2. SET DEFAULT MODEL TO REMI
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { barsToExtend: 8, temperature: 0.8, topK: 0, topP: 1.0, modelType: "remi" },
  });

  const onSubmit = (values: z.infer<typeof formSchema>) => {
    if (!selectedFile) { setFileError("Please select a MIDI file"); return; }
    setFileError(null);
    uploadMutation.mutate({ data: { file: selectedFile } }, {
      onSuccess: (upload) => {
        extendMutation.mutate({ 
          data: { 
            inputFilename: upload.filename, 
            barsToExtend: values.barsToExtend,
            temperature: values.temperature ?? 0.8,
            topK: values.topK ?? 0,
            topP: values.topP ?? 1.0,
            modelType: values.modelType // 3. SEND MODEL CHOICE TO API
          } as any 
        });
      },
      onError: (err: any) => {
        toast({ title: "Upload failed", description: err.message || "Could not upload file", variant: "destructive" });
      },
    });
  };

  const isPending = uploadMutation.isPending || extendMutation.isPending;

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground flex items-center gap-3">
          Extend Composition <BrainCircuit className="w-8 h-8 text-primary opacity-50" />
        </h1>
        <p className="text-muted-foreground mt-2">Upload a seed track and let the PyTorch AI generate the next section.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <Card className="bg-card border-border h-fit">
          <CardHeader>
            <CardTitle>Generation Settings</CardTitle>
            <CardDescription>Configure the neural network parameters for your extension.</CardDescription>
          </CardHeader>
          <CardContent>
            
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                
                {/* 4. THE NEW BRAIN SELECTOR */}
                <FormField control={form.control} name="modelType" render={({ field }) => (
                  <FormItem className="p-4 bg-secondary/20 border border-secondary rounded-lg">
                    <FormLabel className="text-base font-semibold text-primary">AI Architecture</FormLabel>
                    <FormControl>
                      <select
                        {...field}
                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <option value="remi">Standard Model (Single-Track / REMI)</option>
                        <option value="octuple">Multi-Track Model (Full Band / Octuple)</option>
                      </select>
                    </FormControl>
                    <p className="text-xs text-muted-foreground mt-2">
                      {field.value === "remi" 
                        ? "Generates a continuation for only the primary instrument." 
                        : "Generates a coordinated continuation for drums, bass, chords, and melody simultaneously."}
                    </p>
                    <FormMessage />
                  </FormItem>
                )} />

                <div className="space-y-2">
                  <label className="text-sm font-medium leading-none">Seed MIDI File</label>
                  <MidiFileUpload
                    selectedFile={selectedFile}
                    onFileSelect={(f) => { setSelectedFile(f); setFileError(null); }}
                    disabled={isPending}
                  />
                  {fileError && <p className="text-sm font-medium text-destructive">{fileError}</p>}
                </div>

                <FormField control={form.control} name="barsToExtend" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex justify-between"><span>Bars to Extend</span><span className="text-primary font-mono">{field.value ?? 8}</span></FormLabel>
                    <FormControl><Slider min={1} max={64} step={1} value={[field.value ?? 8]} onValueChange={(vals) => field.onChange(vals[0])} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />

                <FormField control={form.control} name="temperature" render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex justify-between"><span>Temperature (Creativity)</span><span className="text-primary font-mono">{Number(field.value ?? 0.8).toFixed(2)}</span></FormLabel>
                    <FormControl><Slider min={0.1} max={2.0} step={0.1} value={[field.value ?? 0.8]} onValueChange={(vals) => field.onChange(vals[0])} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />

                <div className="grid grid-cols-2 gap-4">
                  <FormField control={form.control} name="topK" render={({ field }) => (
                    <FormItem>
                      <FormLabel className="flex justify-between"><span>Top-K</span><span className="text-primary font-mono">{field.value ?? 0}</span></FormLabel>
                      <FormControl><Slider min={0} max={100} step={1} value={[field.value ?? 0]} onValueChange={(vals) => field.onChange(vals[0])} /></FormControl>
                    </FormItem>
                  )} />
                  
                  <FormField control={form.control} name="topP" render={({ field }) => (
                    <FormItem>
                      <FormLabel className="flex justify-between"><span>Top-P</span><span className="text-primary font-mono">{Number(field.value ?? 1.0).toFixed(2)}</span></FormLabel>
                      <FormControl><Slider min={0.1} max={1.0} step={0.05} value={[field.value ?? 1.0]} onValueChange={(vals) => field.onChange(vals[0])} /></FormControl>
                    </FormItem>
                  )} />
                </div>

                <Button type="submit" disabled={isPending} className="w-full">
                  {uploadMutation.isPending ? "Uploading..." : extendMutation.isPending ? "Submitting..." : "Generate Extension"}
                </Button>
              </form>
            </Form>

          </CardContent>
        </Card>

        {currentJobId && (
          <Card className="bg-card border-border h-fit">
            <CardHeader className="pb-3 border-b border-border">
              <div className="flex items-center justify-between">
                <CardTitle>Result</CardTitle>
                <JobStatusBadge status={job?.status ?? "pending"} />
              </div>
            </CardHeader>
            <CardContent className="pt-6 space-y-6">
              {!job ? (
                <div className="text-sm text-muted-foreground">Loading...</div>
              ) : (
                <>
                  <div className="space-y-4">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">File</span>
                      <span className="font-medium truncate max-w-[200px]" title={job.inputFilename}>{job.inputFilename}</span>
                    </div>
                    {job.barsToExtend && (
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Extension Length</span>
                        <span className="font-medium">{job.barsToExtend} bars</span>
                      </div>
                    )}
                  </div>

                  {(job.status === "pending" || job.status === "processing") && (
                    <div className="py-6 flex flex-col items-center gap-3 text-muted-foreground">
                      <div className="w-6 h-6 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                      <p className="text-sm">{job.status === "pending" ? "Queued..." : "Extending your piece..."}</p>
                    </div>
                  )}

                  {job.status === "failed" && (
                    <div className="p-3 text-sm text-red-500 bg-red-500/10 rounded-md border border-red-500/20">
                      {job.errorMessage}
                    </div>
                  )}

                  {job.status === "completed" && (
                    <div className="space-y-6 pt-4 animate-in fade-in slide-in-from-bottom-2 duration-500">
                      
                    {/* Audio Player for the Rendered WAV */}
                      <div className="space-y-3 bg-secondary/30 p-4 rounded-lg border border-border/50">
                        <h4 className="text-sm font-semibold flex items-center justify-center gap-2">
                          <BrainCircuit className="w-5 h-5 text-primary" /> 
                          AI Studio Render
                        </h4>

                        {/* 1. THE VISUALIZER */}
                        <div className="mb-2">
                          <MidiVisualizer 
                            // We load the "full" track so the visualizer matches the full audio file
                            midiUrl={`/api/jobs/${job.id}/download?type=full`} 
                            audioElement={audioEl} 
                          />
                        </div>

                        {/* 2. THE UPDATED AUDIO TAG */}
                        <audio 
                          ref={setAudioEl} // <-- This instantly passes the HTML element to our visualizer state
                          controls 
                          className="w-full h-10 rounded-md" 
                          src={`/api/jobs/${job.id}/download?type=audio`}
                          controlsList="nodownload"
                        >
                          Your browser does not support the audio element.
                        </audio>
                      </div>

                      {/* Dual Download Buttons */}
                      <div className="grid grid-cols-2 gap-3">
                        <Button asChild variant="default" className="w-full gap-2 shadow-sm">
                          <a href={`/api/jobs/${job.id}/download?type=full`} download>
                            <Download className="w-4 h-4" /> Full Song
                          </a>
                        </Button>
                        <Button asChild variant="outline" className="w-full gap-2">
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