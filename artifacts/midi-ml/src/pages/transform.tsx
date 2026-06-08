import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  useTransformMidi,
  useUploadMidiFile,
  getListJobsQueryKey,
  getGetStatsQueryKey,
  useGetJob,
  getGetJobQueryKey,
  useDownloadJobResult,
  getDownloadJobResultQueryKey,
  useListGenres,
  getListGenresQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { JobStatusBadge } from "@/components/job-status-badge";
import { Download } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { MidiFileUpload } from "@/components/midi-file-upload";
import { MidiPlayer } from "@/components/midi-player";

const formSchema = z.object({
  targetGenre: z.string().min(1, "Genre is required"),
});

export default function Transform() {
  const [currentJobId, setCurrentJobId] = useState<number | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: genres, isLoading: genresLoading } = useListGenres({
    query: { queryKey: getListGenresQueryKey() },
  });

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { targetGenre: "" },
  });

  const uploadMutation = useUploadMidiFile();

  const transformMutation = useTransformMidi({
    mutation: {
      onSuccess: (data) => {
        toast({ title: "Job submitted", description: "Your MIDI file is being transformed." });
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

  const onSubmit = (values: z.infer<typeof formSchema>) => {
    if (!selectedFile) { setFileError("Please select a MIDI file"); return; }
    setFileError(null);
    uploadMutation.mutate({ data: { file: selectedFile } }, {
      onSuccess: (upload) => {
        transformMutation.mutate({ data: { inputFilename: upload.filename, targetGenre: values.targetGenre } });
      },
      onError: (err: any) => {
        toast({ title: "Upload failed", description: err.message || "Could not upload file", variant: "destructive" });
      },
    });
  };

  const isPending = uploadMutation.isPending || transformMutation.isPending;
  const selectedGenreName = genres?.find((g) => g.id === form.watch("targetGenre"))?.name;

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Genre Transform</h1>
        <p className="text-muted-foreground mt-2">Re-arrange your MIDI composition into an entirely new genre.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle>Configure Job</CardTitle>
            <CardDescription>Select your MIDI file and target style.</CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                <div className="space-y-2">
                  <label className="text-sm font-medium leading-none">MIDI File</label>
                  <MidiFileUpload
                    selectedFile={selectedFile}
                    onFileSelect={(f) => { setSelectedFile(f); setFileError(null); }}
                    disabled={isPending}
                  />
                  {fileError && <p className="text-sm font-medium text-destructive">{fileError}</p>}
                </div>

                <FormField
                  control={form.control}
                  name="targetGenre"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Target Genre</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-genre">
                            <SelectValue placeholder="Select a genre" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {genresLoading ? (
                            <div className="p-2 space-y-2">
                              <Skeleton className="h-4 w-24" /><Skeleton className="h-4 w-20" />
                            </div>
                          ) : (
                            genres?.map((genre) => (
                              <SelectItem key={genre.id} value={genre.id}>
                                {genre.name}
                              </SelectItem>
                            ))
                          )}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <Button type="submit" disabled={isPending} className="w-full" data-testid="button-submit">
                  {uploadMutation.isPending ? "Uploading..." : transformMutation.isPending ? "Submitting..." : "Transform MIDI"}
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>

        {currentJobId && (
          <Card className="bg-card border-border h-fit">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Result</CardTitle>
                <JobStatusBadge status={job?.status ?? "pending"} />
              </div>
              <CardDescription>
                {selectedGenreName ? `Transformed to ${selectedGenreName}` : "Transformation in progress"}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {!job ? (
                <div className="text-sm text-muted-foreground">Loading job details...</div>
              ) : (
                <>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Job ID</span>
                      <span className="font-mono">{job.id}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Input</span>
                      <span className="font-mono truncate max-w-48">{job.inputFilename}</span>
                    </div>
                    {job.targetGenre && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Target genre</span>
                        <span className="font-medium text-primary capitalize">{job.targetGenre}</span>
                      </div>
                    )}
                  </div>

                  {(job.status === "pending" || job.status === "processing") && (
                    <div className="py-6 flex flex-col items-center gap-3 text-muted-foreground">
                      <div className="w-6 h-6 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                      <p className="text-sm">
                        {job.status === "pending" ? "Queued..." : `Applying ${job.targetGenre ?? "genre"} style...`}
                      </p>
                    </div>
                  )}

                  {job.status === "failed" && (
                    <div className="p-3 text-sm text-red-500 bg-red-500/10 rounded-md border border-red-500/20">
                      {job.errorMessage}
                    </div>
                  )}

                  {job.status === "completed" && downloadInfo && (
                    <div className="space-y-3">
                      <MidiPlayer url={downloadInfo.url} label={`${selectedGenreName ?? job.targetGenre ?? "Transformed"} version`} />
                      <Button asChild variant="outline" className="w-full gap-2" data-testid="button-download">
                        <a href={downloadInfo.url} download={downloadInfo.filename}>
                          <Download className="w-4 h-4" /> Download MIDI
                        </a>
                      </Button>
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
