import { useListJobs } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { JobStatusBadge } from "@/components/job-status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import { useDownloadJobResult } from "@workspace/api-client-react";
import { useState } from "react";

function DownloadCell({ jobId, status }: { jobId: number, status: string }) {
  const [downloading, setDownloading] = useState(false);
  
  const { data: downloadInfo, refetch } = useDownloadJobResult(jobId, {
    query: {
      enabled: false,
    }
  });

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
      data-testid={`btn-download-${jobId}`}
    >
      <Download className="w-3 h-3" />
      {downloading ? "..." : "File"}
    </Button>
  );
}

export default function Jobs() {
  const { data: jobs, isLoading } = useListJobs();

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
          ) : !jobs || jobs.length === 0 ? (
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
                    <TableHead>Created At</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.map((job) => (
                    <TableRow key={job.id} data-testid={`job-row-${job.id}`}>
                      <TableCell className="font-mono text-muted-foreground">{job.id}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="capitalize">{job.type.replace('_', ' ')}</Badge>
                      </TableCell>
                      <TableCell className="font-medium">{job.inputFilename}</TableCell>
                      <TableCell>
                        <JobStatusBadge status={job.status} />
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {new Date(job.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <DownloadCell jobId={job.id} status={job.status} />
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
