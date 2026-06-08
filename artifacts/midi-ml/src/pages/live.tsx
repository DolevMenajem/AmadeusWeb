import { useState, useRef, useEffect } from "react";
import {
  useLiveExtendMidi,
  useUploadMidiFile,
  getListJobsQueryKey,
  getGetStatsQueryKey,
  useGetJob,
  getGetJobQueryKey,
  useDownloadJobResult,
  getDownloadJobResultQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { MidiPlayer } from "@/components/midi-player";
import { cn } from "@/lib/utils";
import { Upload, Zap, Music, Bot, Clock } from "lucide-react";

interface Exchange {
  id: string;
  jobId: number | null;
  inputFile: File;
  barsRequested: number;
  submittedAt: Date;
  respondedAt: Date | null;
  latencyMs: number | null;
}

function ExchangeCard({ exchange, barsRequested }: { exchange: Exchange; barsRequested: number }) {
  const { data: job } = useGetJob(exchange.jobId as number, {
    query: {
      enabled: !!exchange.jobId,
      queryKey: getGetJobQueryKey(exchange.jobId as number),
      refetchInterval: (query) => {
        const s = query.state.data?.status;
        return s === "pending" || s === "processing" ? 1000 : false;
      },
    },
  });

  const { data: downloadInfo } = useDownloadJobResult(exchange.jobId as number, {
    query: {
      enabled: !!exchange.jobId && job?.status === "completed",
      queryKey: getDownloadJobResultQueryKey(exchange.jobId as number),
    },
  });

  const latency = exchange.latencyMs ?? (job?.completedAt ? new Date(job.completedAt).getTime() - exchange.submittedAt.getTime() : null);

  return (
    <div className="space-y-2 animate-in slide-in-from-bottom-2 duration-300">
      {/* User input bubble */}
      <div className="flex items-start gap-3 justify-end">
        <div className="max-w-sm">
          <div className="bg-primary/15 border border-primary/25 rounded-2xl rounded-tr-sm px-4 py-3 space-y-1">
            <div className="flex items-center gap-2 text-xs text-primary font-medium">
              <Music className="w-3 h-3" />
              You played
            </div>
            <p className="text-sm font-mono text-foreground">{exchange.inputFile.name}</p>
            <p className="text-xs text-muted-foreground">{(exchange.inputFile.size / 1024).toFixed(1)} KB · {barsRequested} bars requested</p>
          </div>
          <p className="text-xs text-muted-foreground text-right mt-1 px-1">
            {exchange.submittedAt.toLocaleTimeString()}
          </p>
        </div>
        <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center shrink-0 mt-1">
          <Music className="w-4 h-4 text-primary" />
        </div>
      </div>

      {/* AI response bubble */}
      <div className="flex items-start gap-3">
        <div className={cn(
          "w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-1 transition-all",
          job?.status === "completed" ? "bg-violet-500/20" : "bg-secondary"
        )}>
          {(!job || job.status === "pending" || job.status === "processing") ? (
            <div className="w-4 h-4 rounded-full border-2 border-muted-foreground border-t-transparent animate-spin" />
          ) : (
            <Bot className="w-4 h-4 text-violet-400" />
          )}
        </div>
        <div className="max-w-sm flex-1">
          <div className={cn(
            "border rounded-2xl rounded-tl-sm px-4 py-3 space-y-2 transition-colors",
            job?.status === "completed"
              ? "bg-violet-500/10 border-violet-500/25"
              : job?.status === "failed"
              ? "bg-red-500/10 border-red-500/20"
              : "bg-secondary/50 border-border"
          )}>
            <div className="flex items-center gap-2 text-xs font-medium text-violet-400">
              <Bot className="w-3 h-3" />
              Amadeus
              {latency && (
                <span className="text-muted-foreground flex items-center gap-1 ml-1">
                  <Clock className="w-2.5 h-2.5" /> {(latency / 1000).toFixed(1)}s
                </span>
              )}
            </div>

            {!job || job.status === "pending" ? (
              <p className="text-xs text-muted-foreground">Queued...</p>
            ) : job.status === "processing" ? (
              <p className="text-xs text-muted-foreground animate-pulse">Generating continuation...</p>
            ) : job.status === "failed" ? (
              <p className="text-xs text-red-400">{job.errorMessage ?? "Generation failed."}</p>
            ) : downloadInfo ? (
              <MidiPlayer url={downloadInfo.url} compact />
            ) : (
              <p className="text-xs text-muted-foreground">Loading result...</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LiveExtend() {
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [barsToExtend, setBarsToExtend] = useState(4);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const uploadMutation = useUploadMidiFile();
  const liveExtendMutation = useLiveExtendMidi();

  const isSubmitting = uploadMutation.isPending || liveExtendMutation.isPending;

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [exchanges]);

  const submit = (file: File) => {
    setSelectedFile(null);
    const tempId = crypto.randomUUID();
    const now = new Date();

    uploadMutation.mutate({ data: { file } }, {
      onSuccess: (upload) => {
        liveExtendMutation.mutate(
          { data: { inputFilename: upload.filename, barsToExtend } },
          {
            onSuccess: (job) => {
              setExchanges((prev) =>
                prev.map((e) => e.id === tempId ? { ...e, jobId: job.id } : e)
              );
              queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
              queryClient.invalidateQueries({ queryKey: getGetStatsQueryKey() });
            },
            onError: (err: any) => {
              setExchanges((prev) => prev.filter((e) => e.id !== tempId));
              toast({ title: "Generation failed", description: err.message ?? "Unknown error", variant: "destructive" });
            },
          }
        );
      },
      onError: (err: any) => {
        setExchanges((prev) => prev.filter((e) => e.id !== tempId));
        toast({ title: "Upload failed", description: err.message ?? "Could not upload file", variant: "destructive" });
      },
    });

    setExchanges((prev) => [...prev, {
      id: tempId,
      jobId: null,
      inputFile: file,
      barsRequested: barsToExtend,
      submittedAt: now,
      respondedAt: null,
      latencyMs: null,
    }]);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) submit(file);
    e.target.value = "";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && (file.name.endsWith(".mid") || file.name.endsWith(".midi"))) submit(file);
  };

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] animate-in fade-in duration-300">
      {/* Header */}
      <div className="shrink-0 pb-4 border-b border-border mb-4">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-bold tracking-tight">Live Extension</h1>
          <div className="bg-primary/20 text-primary px-2 py-1 rounded text-xs font-bold tracking-widest flex items-center gap-1">
            <Zap className="w-3 h-3 fill-primary" /> REALTIME
          </div>
        </div>
        <p className="text-muted-foreground mt-1 text-sm">
          Play live into your computer, drop the snippet — Amadeus responds instantly. Back and forth, like a real session.
        </p>
      </div>

      {/* Session feed */}
      <div
        ref={feedRef}
        className="flex-1 overflow-y-auto space-y-6 py-4 pr-1"
        data-testid="session-feed"
      >
        {exchanges.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center text-muted-foreground gap-4 pb-8">
            <div className="w-16 h-16 rounded-2xl bg-secondary flex items-center justify-center">
              <Bot className="w-8 h-8" />
            </div>
            <div>
              <p className="font-medium text-foreground">Start the session</p>
              <p className="text-sm mt-1">Record a snippet from your instrument and drop it below.<br />Amadeus will respond with a continuation.</p>
            </div>
          </div>
        ) : (
          exchanges.map((ex) => (
            <ExchangeCard key={ex.id} exchange={ex} barsRequested={ex.barsRequested} />
          ))
        )}
      </div>

      {/* Input bar */}
      <div className="shrink-0 pt-4 border-t border-border">
        <div
          onDrop={handleDrop}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          className={cn(
            "rounded-xl border-2 border-dashed p-4 transition-all",
            isDragging ? "border-primary bg-primary/10" : "border-border bg-secondary/20"
          )}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".mid,.midi"
            className="hidden"
            onChange={handleFileChange}
            data-testid="input-file"
          />

          <div className="flex items-center gap-4">
            {/* Bars selector */}
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Bars</span>
              <div className="flex gap-1">
                {[1, 2, 4, 8].map((b) => (
                  <button
                    key={b}
                    onClick={() => setBarsToExtend(b)}
                    data-testid={`bars-${b}`}
                    className={cn(
                      "w-8 h-8 rounded-md text-xs font-bold transition-colors",
                      barsToExtend === b
                        ? "bg-primary text-primary-foreground"
                        : "bg-secondary hover:bg-secondary/80 text-muted-foreground"
                    )}
                  >
                    {b}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1 text-center">
              {isDragging ? (
                <p className="text-sm font-medium text-primary">Drop your MIDI snippet</p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Drop a <span className="font-mono text-foreground">.mid</span> file here
                </p>
              )}
            </div>

            <Button
              onClick={() => fileInputRef.current?.click()}
              disabled={isSubmitting}
              className="gap-2 shrink-0"
              data-testid="button-send"
            >
              {isSubmitting ? (
                <><div className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" /> Sending...</>
              ) : (
                <><Upload className="w-4 h-4" /> Send snippet</>
              )}
            </Button>
          </div>
        </div>

        {exchanges.length > 0 && (
          <p className="text-xs text-muted-foreground text-center mt-2">
            {exchanges.length} exchange{exchanges.length !== 1 ? "s" : ""} in this session
          </p>
        )}
      </div>
    </div>
  );
}
