import { Badge } from "@/components/ui/badge";

export function JobStatusBadge({ status }: { status: "pending" | "processing" | "completed" | "failed" }) {
  switch (status) {
    case "pending":
      return <Badge variant="secondary" className="bg-yellow-500/10 text-yellow-500 hover:bg-yellow-500/20 border-yellow-500/20">Pending</Badge>;
    case "processing":
      return <Badge variant="secondary" className="bg-blue-500/10 text-blue-500 hover:bg-blue-500/20 border-blue-500/20 animate-pulse">Processing</Badge>;
    case "completed":
      return <Badge variant="default" className="bg-green-500/10 text-green-500 hover:bg-green-500/20 border-green-500/20">Completed</Badge>;
    case "failed":
      return <Badge variant="destructive" className="bg-red-500/10 text-red-500 hover:bg-red-500/20 border-red-500/20">Failed</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}
