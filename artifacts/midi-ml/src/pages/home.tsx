import { useGetStats, useListJobs } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { Activity } from "lucide-react";

export default function Home() {
  const { data: stats, isLoading: statsLoading } = useGetStats();
  const { data: jobs, isLoading: jobsLoading } = useListJobs();
  
  // 1. Pull the Live Jam sessions from local memory
  const [liveMessages, , isActiveHydrated] = useLocalStorage<any[]>("amadeus_live_session", []);
  const [savedJams, , isSavedHydrated] = useLocalStorage<any[]>("amadeus_saved_jams", []);

  // 2. Stitch them together (using the TS-safe spread!)
  let combinedActivity: any[] = jobs ? [...jobs] : [];

  if (isSavedHydrated && savedJams && savedJams.length > 0) {
    combinedActivity.push(...savedJams);
  }

  if (isActiveHydrated && liveMessages && liveMessages.length > 0) {
    combinedActivity.push({
      id: "live-active",
      type: "live_jam",
      inputFilename: `Active Jam Session (${liveMessages.length} turns)`,
      status: "in-progress",
      createdAt: liveMessages[liveMessages.length - 1].timestamp,
      isLocal: true,
      isActive: true,
    });
  }

  // Sort newest to oldest and take the top 5
  combinedActivity.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const recentJobs = combinedActivity.slice(0, 5);

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Dashboard</h1>
        <p className="text-muted-foreground mt-2">Platform overview and recent activity.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Total Jobs</CardTitle>
          </CardHeader>
          <CardContent>
            {statsLoading ? <Skeleton className="h-10 w-24" /> : (
              <div className="text-4xl font-bold text-primary" data-testid="text-total-jobs">{stats?.totalJobs || 0}</div>
            )}
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Completed</CardTitle>
          </CardHeader>
          <CardContent>
            {statsLoading ? <Skeleton className="h-10 w-24" /> : (
              <div className="text-4xl font-bold text-green-500" data-testid="text-completed-jobs">{stats?.completedJobs || 0}</div>
            )}
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Failed</CardTitle>
          </CardHeader>
          <CardContent>
            {statsLoading ? <Skeleton className="h-10 w-24" /> : (
              <div className="text-4xl font-bold text-destructive" data-testid="text-failed-jobs">{stats?.failedJobs || 0}</div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold tracking-tight text-foreground">Recent Activity</h2>
          <Link href="/jobs" className="text-sm text-primary hover:underline" data-testid="link-view-all">View all jobs</Link>
        </div>
        
        <div className="space-y-3">
          {jobsLoading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))
          ) : recentJobs.length === 0 ? (
            <div className="text-center p-8 border border-border rounded-lg bg-card text-muted-foreground">
              No jobs found. Start by running a new job.
            </div>
          ) : (
            recentJobs.map(job => (
              <Card 
                key={job.id} 
                className={`bg-card flex items-center justify-between p-4 ${job.isLocal ? 'border-primary/50 shadow-sm shadow-primary/10' : 'border-border'}`}
                data-testid={`card-job-${job.id}`}
              >
                <div className="flex items-center gap-4">
                  <div className={`w-10 h-10 rounded flex items-center justify-center font-medium text-sm ${job.isLocal ? 'bg-primary/20 text-primary' : 'bg-secondary text-secondary-foreground'}`}>
                    {job.isLocal ? <Activity className="w-5 h-5" /> : job.type.substring(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <h3 className="font-medium text-foreground">{job.inputFilename}</h3>
                    <div className="flex items-center gap-2 mt-1">
                      <Badge variant={job.isLocal ? "default" : "outline"} className="text-xs">
                        {job.type.replace('_', ' ')}
                      </Badge>
                      <span className="text-xs text-muted-foreground">{new Date(job.createdAt).toLocaleString()}</span>
                    </div>
                  </div>
                </div>
                <div>
                  <Badge variant={job.status === "completed" ? "default" : job.status === "failed" ? "destructive" : job.status === "in-progress" ? "secondary" : "secondary"}>
                    {job.status}
                  </Badge>
                </div>
              </Card>
            ))
          )}
        </div>
      </div>
    </div>
  );
}