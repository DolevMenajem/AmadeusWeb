import { useMemo } from "react";
import { useGetStats, useListJobs } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "wouter";
import { useLocalStorage } from "@/hooks/use-local-storage";
// Added new icons for the stat cards to make them pop!
import { Activity, CheckCircle2, XCircle, ListMusic } from "lucide-react";

export default function Home() {
  // 1. Fetch global statistics and API-backed jobs from the backend database
  const { data: stats, isLoading: statsLoading } = useGetStats();
  const { data: jobs, isLoading: jobsLoading } = useListJobs();
  
  // 2. Pull the Live Jam sessions (both active drafts and saved archives) from browser memory
  const [liveMessages, , isActiveHydrated] = useLocalStorage<any[]>("amadeus_live_session", []);
  const [savedJams, , isSavedHydrated] = useLocalStorage<any[]>("amadeus_saved_jams", []);

  // 3. OPTIMIZATION: useMemo prevents this array stitching/sorting from running on every single render.
  // It will only recalculate if the actual underlying data changes.
  const recentJobs = useMemo(() => {
    // Start with the API jobs (defaulting to an empty array if still loading)
    let combinedActivity: any[] = jobs ? [...jobs] : [];

    // If we have saved local jams, append them to the master list
    if (isSavedHydrated && savedJams && savedJams.length > 0) {
      combinedActivity.push(...savedJams);
    }

    // If there is an active Live Jam session (with at least one message), format and append it
    if (isActiveHydrated && liveMessages && liveMessages.length > 0) {
      combinedActivity.push({
        id: "live-active",
        type: "live_jam",
        inputFilename: `Active Jam Session (${liveMessages.length} turns)`,
        status: "in-progress",
        createdAt: liveMessages[liveMessages.length - 1].timestamp, // Use the time of the last played note
        isLocal: true,
        isActive: true,
      });
    }

    // Sort the combined list from newest (most recent) to oldest
    combinedActivity.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    
    // Return only the top 5 most recent jobs for the dashboard view
    return combinedActivity.slice(0, 5);
  }, [jobs, savedJams, liveMessages, isSavedHydrated, isActiveHydrated]); // Dependency array

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      
      {/* Page Header */}
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Dashboard</h1>
        <p className="text-muted-foreground mt-2">Platform overview and recent activity.</p>
      </div>

      {/* STAT CARDS ROW */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        
        {/* Card 1: Total Jobs */}
        {/* VISUALS: Added gradient background, subtle drop shadow, and a decorative absolute icon */}
        <Card className="bg-gradient-to-br from-card to-background/50 border-border shadow-md shadow-black/20 relative overflow-hidden">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Total Jobs</CardTitle>
            <ListMusic className="absolute right-4 top-4 w-12 h-12 text-primary/10" />
          </CardHeader>
          <CardContent>
            {statsLoading ? <Skeleton className="h-10 w-24" /> : (
              <div className="text-4xl font-bold text-primary" data-testid="text-total-jobs">{stats?.totalJobs || 0}</div>
            )}
          </CardContent>
        </Card>

        {/* Card 2: Completed */}
        <Card className="bg-gradient-to-br from-card to-background/50 border-border shadow-md shadow-black/20 relative overflow-hidden">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Completed</CardTitle>
            <CheckCircle2 className="absolute right-4 top-4 w-12 h-12 text-green-500/10" />
          </CardHeader>
          <CardContent>
            {statsLoading ? <Skeleton className="h-10 w-24" /> : (
              <div className="text-4xl font-bold text-green-500" data-testid="text-completed-jobs">{stats?.completedJobs || 0}</div>
            )}
          </CardContent>
        </Card>

        {/* Card 3: Failed */}
        <Card className="bg-gradient-to-br from-card to-background/50 border-border shadow-md shadow-black/20 relative overflow-hidden">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Failed</CardTitle>
            <XCircle className="absolute right-4 top-4 w-12 h-12 text-destructive/10" />
          </CardHeader>
          <CardContent>
            {statsLoading ? <Skeleton className="h-10 w-24" /> : (
              <div className="text-4xl font-bold text-destructive" data-testid="text-failed-jobs">{stats?.failedJobs || 0}</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* RECENT ACTIVITY LIST */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold tracking-tight text-foreground">Recent Activity</h2>
          <Link href="/jobs" className="text-sm text-primary hover:underline" data-testid="link-view-all">View all jobs</Link>
        </div>
        
        <div className="space-y-3">
          {jobsLoading ? (
            // Loading state placeholders
            Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))
          ) : recentJobs.length === 0 ? (
            // Empty state
            <div className="text-center p-8 border border-border rounded-lg bg-card text-muted-foreground">
              No jobs found. Start by running a new job.
            </div>
          ) : (
            // Render the sorted jobs list
            recentJobs.map(job => (
              <Card 
                key={job.id} 
                className={`bg-gradient-to-r from-card to-background/50 flex items-center justify-between p-4 transition-all hover:bg-white/5 hover:shadow-md ${job.isLocal ? 'border-primary/50 shadow-sm shadow-primary/20' : 'border-border shadow-sm shadow-black/20'}`}
                data-testid={`card-job-${job.id}`}
              >
                <div className="flex items-center gap-4">
                  {/* Icon Block */}
                  <div className={`w-10 h-10 rounded flex items-center justify-center font-medium text-sm ${job.isLocal ? 'bg-primary/20 text-primary' : 'bg-secondary text-secondary-foreground'}`}>
                    {job.isLocal ? <Activity className="w-5 h-5" /> : job.type.substring(0, 2).toUpperCase()}
                  </div>
                  
                  {/* Job Details */}
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

                {/* Status Badge */}
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