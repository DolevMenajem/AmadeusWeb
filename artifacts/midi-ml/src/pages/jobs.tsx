import { useListJobs, useDownloadJobResult } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { JobStatusBadge } from "@/components/job-status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Download, PlayCircle, Activity, FolderOpen } from "lucide-react";
import { useState } from "react";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { Link, useLocation } from "wouter";

function DownloadCell({ jobId, status, isLocal }: { jobId: number | string, status: string, isLocal?: boolean }) {
  const [downloading, setDownloading] = useState(false);
  
  const { data: downloadInfo, refetch } = useDownloadJobResult(jobId as number, {
    query: { enabled: false }
  });

  // Update the if-statement in DownloadCell:
  if (isLocal) {
    // If it's the active session, show Resume
    if (jobId === "live-active") {
      return (
        <Link href="/live">
          <Button variant="secondary" size="sm" className="h-8 gap-2 text-primary border-primary/20">
            <PlayCircle className="w-3 h-3" /> Resume Jam
          </Button>
        </Link>
      );
    }
    // If it's an archived session, just show a badge for now (or wire up a download button later!)
    return <span className="text-muted-foreground text-xs italic">Archived Locally</span>;
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

  if (status !== "completed") return <span className="text-muted-foreground text-xs">-</span>;

  return (
    <Button 
      variant="ghost" 
      size="sm" 
      className="h-8 gap-2" 
      onClick={handleDownload}
      disabled={downloading}
    >
      <Download className="w-3 h-3" />
      {downloading ? "..." : "File"}
    </Button>
  );
}

function LocalActionCell({ job }: { job: any }) {
  // We need the setter to overwrite the active draft
  const [, setLiveMessages] = useLocalStorage<any[]>("amadeus_live_session", []);
  // We need wouter's location hook to redirect the user
  const [, setLocation] = useLocation();

  // If it is the current active session, just link to it
  if (job.isActive) {
    return (
      <Link href="/live">
        <Button variant="secondary" size="sm" className="h-8 gap-2 text-primary border-primary/20">
          <PlayCircle className="w-3 h-3" /> Resume Jam
        </Button>
      </Link>
    );
  }

  // If it is an archived session, restore it to the active draft and redirect
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
      className="h-8 gap-2 hover:bg-primary/10 hover:text-primary" 
      onClick={handleRestore}
    >
      <FolderOpen className="w-3 h-3" /> Load Jam
    </Button>
  );
}

export default function Jobs() {
  const { data: jobs, isLoading } = useListJobs();

  const [liveMessages, , isActiveHydrated] = useLocalStorage<any[]>("amadeus_live_session", []);
  const [savedJams, , isSavedHydrated] = useLocalStorage<any[]>("amadeus_saved_jams", []);

  // Stitch and sort the timeline
  let combinedActivity: any[] = jobs ? [...jobs] : [];

  // 1. Add Archived Local Jams
  if (isSavedHydrated && savedJams && savedJams.length > 0) {
    combinedActivity.push(...savedJams);
  }

  // 2. Add Active Local Jam (if it has messages)
  if (isActiveHydrated && liveMessages && liveMessages.length > 0) {
    combinedActivity.push({
      id: "live-active",
      type: "live_jam",
      inputFilename: `Active Jam Session (${liveMessages.length} turns)`,
      status: "in-progress",
      createdAt: liveMessages[liveMessages.length - 1].timestamp,
      isLocal: true,
      isActive: true, // New flag so we know it's the active one
    });
  }
  
  combinedActivity.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">All Jobs</h1>
        <p className="text-muted-foreground mt-2">Complete history of all processing tasks.</p>
      </div>

      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle>Job Queue</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : combinedActivity.length === 0 ? (
            <div className="text-center p-12 border border-border rounded-lg text-muted-foreground">
              No jobs found.
            </div>
          ) : (
            <div className="rounded-md border border-border overflow-hidden">
              <Table>
                <TableHeader className="bg-secondary/50">
                  <TableRow>
                    <TableHead className="w-[100px]">ID</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Input</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last Active</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {combinedActivity.map((job) => (
                    <TableRow 
                      key={job.id} 
                      className={job.isLocal ? "bg-primary/5 hover:bg-primary/10" : ""}
                    >
                      <TableCell className="font-mono text-muted-foreground">
                        {job.isLocal ? <Activity className="w-4 h-4 text-primary" /> : job.id}
                      </TableCell>
                      <TableCell>
                        <Badge variant={job.isLocal ? "default" : "outline"} className="capitalize">
                          {job.type.replace('_', ' ')}
                        </Badge>
                      </TableCell>
                      <TableCell className={`font-medium ${job.isLocal ? "text-primary" : ""}`}>
                        {job.inputFilename}
                      </TableCell>
                      <TableCell>
                        {job.isLocal ? (
                           <Badge variant="secondary" className="border-primary/20 text-primary">In Progress</Badge>
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