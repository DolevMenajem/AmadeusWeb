import { useState, useMemo } from "react";
import { useListJobs, useDownloadJobResult } from "@workspace/api-client-react";
import { Link, useLocation } from "wouter";
import { useLocalStorage } from "@/hooks/use-local-storage";

// UI Components
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { JobStatusBadge } from "@/components/job-status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { InlineEdit } from "@/components/inline-edit";

// Icons
import { Download, PlayCircle, Activity, FolderOpen, Database, Layers } from "lucide-react";

// --- HELPER COMPONENTS ---

/**
 * DownloadCell: Handles fetching the secure URL and downloading the finished MIDI/WAV files.
 */
function DownloadCell({ jobId, status, isLocal }: { jobId: number | string, status: string, isLocal?: boolean }) {
  const [downloading, setDownloading] = useState(false);
  
  const { data: downloadInfo, refetch } = useDownloadJobResult(jobId as number, {
    query: { enabled: false }
  });

  if (isLocal) {
    if (jobId === "live-active") {
      return (
        <Link href="/live">
          <Button variant="secondary" size="sm" className="h-8 gap-2 text-primary border-primary/20 shadow-sm hover:shadow-primary/20 transition-all">
            <PlayCircle className="w-3 h-3" /> Resume Jam
          </Button>
        </Link>
      );
    }
    return <span className="text-muted-foreground text-xs italic bg-background/50 px-2 py-1 rounded">Archived Locally</span>;
  }

  const handleDownload = async () => {
    if (status !== "completed") return;
    setDownloading(true);
    try {
      const res = await refetch();
      if (res.data) {
        const a = document.createElement("a");
        a.href = res.data.url;
        a.download = res.data.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }
    } finally {
      setDownloading(false);
    }
  };

  if (status !== "completed") return <span className="text-muted-foreground text-xs opacity-50">-</span>;

  return (
    <Button 
      variant="ghost" 
      size="sm" 
      className="h-8 gap-2 hover:bg-primary/10 hover:text-primary transition-colors" 
      onClick={handleDownload}
      disabled={downloading}
    >
      <Download className="w-3 h-3" />
      {downloading ? "..." : "File"}
    </Button>
  );
}

/**
 * LocalActionCell: Handles restoring a saved Live Jam back into the active draft slot.
 */
function LocalActionCell({ job }: { job: any }) {
  const [, setLiveMessages] = useLocalStorage<any[]>("amadeus_live_session", []);
  const [, setLocation] = useLocation();

  if (job.isActive) {
    return (
      <Link href="/live">
        <Button variant="secondary" size="sm" className="h-8 gap-2 text-primary border-primary/20 shadow-sm hover:shadow-primary/20 transition-all">
          <PlayCircle className="w-3 h-3" /> Resume Jam
        </Button>
      </Link>
    );
  }

  const handleRestore = () => {
    if (confirm("Restore this jam? This will overwrite your current active jam draft.")) {
      setLiveMessages(job.messages || []);
      setLocation("/live");
    }
  };

  return (
    <Button 
      variant="outline" 
      size="sm" 
      className="h-8 gap-2 hover:bg-primary/10 hover:text-primary transition-colors" 
      onClick={handleRestore}
    >
      <FolderOpen className="w-3 h-3" /> Load Jam
    </Button>
  );
}


// --- MAIN COMPONENT ---
export default function Jobs() {
  // 1. Fetch data
  const { data: jobs, isLoading } = useListJobs();
  const [liveMessages, , isActiveHydrated] = useLocalStorage<any[]>("amadeus_live_session", []);
  const [savedJams, setSavedJams, isSavedHydrated] = useLocalStorage<any[]>("amadeus_saved_jams", []);

  // 2. OPTIMIZATION: Memoize the timeline stitching so it only runs when data actually changes
  const combinedActivity = useMemo(() => {
    let combined: any[] = jobs ? [...jobs] : [];

    if (isSavedHydrated && savedJams && savedJams.length > 0) {
      combined.push(...savedJams);
    }

    if (isActiveHydrated && liveMessages && liveMessages.length > 0) {
      combined.push({
        id: "live-active",
        type: "live_jam",
        inputFilename: `Active Jam Session (${liveMessages.length} turns)`,
        status: "in-progress",
        createdAt: liveMessages[liveMessages.length - 1].timestamp,
        isLocal: true,
        isActive: true, 
      });
    }
    
    // Sort newest to oldest
    return combined.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [jobs, savedJams, liveMessages, isSavedHydrated, isActiveHydrated]);

  // --- RENDER ---
  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      
      {/* Page Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground flex items-center gap-3">
          All Jobs <Layers className="w-8 h-8 text-primary opacity-80" />
        </h1>
        <p className="text-muted-foreground mt-2">Complete history of all processing tasks across the platform.</p>
      </div>

      {/* Main Table Card */}
      {/* VISUALS: Deep gradient background and sleek shadow */}
      <Card className="bg-gradient-to-br from-card to-background/50 border-border shadow-lg shadow-black/20 overflow-hidden">
        <CardHeader className="bg-secondary/5 border-b border-border/50 pb-4">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Database className="w-4 h-4 text-primary" /> Job Queue
          </CardTitle>
        </CardHeader>
        
        <CardContent className="pt-6">
          {isLoading ? (
            <div className="space-y-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full bg-secondary/20" />
              ))}
            </div>
          ) : combinedActivity.length === 0 ? (
            <div className="text-center p-12 border border-border/50 rounded-lg text-muted-foreground bg-background/30 flex flex-col items-center gap-3">
              <Database className="w-8 h-8 opacity-20" />
              No jobs found in the database or local cache.
            </div>
          ) : (
            // VISUALS: Added a subtle glassmorphic wrapper to the table
            <div className="rounded-md border border-border/50 overflow-hidden bg-background/30 backdrop-blur-sm shadow-inner">
              <Table>
                
                {/* Header */}
                <TableHeader className="bg-secondary/30">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-[100px] text-xs uppercase tracking-widest">ID</TableHead>
                    <TableHead className="text-xs uppercase tracking-widest">Type</TableHead>
                    <TableHead className="text-xs uppercase tracking-widest">Input</TableHead>
                    <TableHead className="text-xs uppercase tracking-widest">Status</TableHead>
                    <TableHead className="text-xs uppercase tracking-widest">Last Active</TableHead>
                    <TableHead className="text-right text-xs uppercase tracking-widest">Action</TableHead>
                  </TableRow>
                </TableHeader>
                
                {/* Body */}
                <TableBody>
                  {combinedActivity.map((job) => (
                    <TableRow 
                      key={job.id} 
                      // VISUALS: Different hover states depending on if it's a local jam or a DB job
                      className={`transition-colors ${
                        job.isLocal 
                          ? "bg-primary/[0.03] hover:bg-primary/10" 
                          : "hover:bg-white/5"
                      }`}
                    >
                      <TableCell className="font-mono text-muted-foreground">
                        {job.isLocal ? <Activity className="w-4 h-4 text-primary" /> : job.id}
                      </TableCell>
                      
                      <TableCell>
                        <Badge variant={job.isLocal ? "default" : "outline"} className={`capitalize ${job.isLocal ? "shadow-sm shadow-primary/20" : ""}`}>
                          {job.type.replace('_', ' ')}
                        </Badge>
                      </TableCell>
                      
                      <TableCell className={`font-medium ${job.isLocal ? "text-primary" : ""}`}>
                        {job.isLocal ? (
                          job.isActive ? (
                            <span className="opacity-90">{job.inputFilename}</span>
                          ) : (
                            <InlineEdit 
                              jobId={job.id} 
                              initialValue={job.inputFilename} 
                              onSave={async (newValue) => {
                                const updatedJams = savedJams.map((j: any) => 
                                  j.id === job.id ? { ...j, inputFilename: newValue } : j
                                );
                                setSavedJams(updatedJams); 
                              }}
                            />
                          )
                        ) : (
                          <InlineEdit jobId={job.id} initialValue={job.inputFilename} />
                        )}
                      </TableCell>
                      
                      <TableCell>
                        {job.isLocal ? (
                           <Badge variant="secondary" className="border-primary/20 text-primary bg-primary/10">In Progress</Badge>
                        ) : (
                           <JobStatusBadge status={job.status} />
                        )}
                      </TableCell>
                      
                      <TableCell className="text-muted-foreground text-sm">
                        {new Date(job.createdAt).toLocaleString()}
                      </TableCell>
                      
                      <TableCell className="text-right">
                        {job.isLocal ? (
                          <LocalActionCell job={job} />
                        ) : (
                          <DownloadCell jobId={job.id} status={job.status} />
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}