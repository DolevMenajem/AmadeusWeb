import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { Home, Music, FastForward, Activity, List, Music2 } from "lucide-react";
import { useHealthCheck } from "@workspace/api-client-react";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { data: health } = useHealthCheck();

  const nav = [
    { href: "/", label: "Dashboard", icon: Home },
    { href: "/extend", label: "Extension", icon: FastForward },
    { href: "/transform", label: "Transform", icon: Music },
    { href: "/evaluate", label: "Evaluation", icon: Activity },
    { href: "/live", label: "Live Extend", icon: Music2 },
    { href: "/jobs", label: "All Jobs", icon: List },
  ];

  return (
    <div className="flex h-screen w-full bg-background text-foreground overflow-hidden">
      <aside className="w-64 border-r border-border bg-card flex flex-col">
        <div className="p-6 border-b border-border flex items-center gap-3">
          <div className="w-8 h-8 rounded bg-primary flex items-center justify-center text-primary-foreground font-bold text-xs">
            AM
          </div>
          <div>
            <h1 className="font-bold tracking-tight text-lg leading-tight">Amadeus</h1>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className={cn("w-2 h-2 rounded-full", health?.status === "ok" ? "bg-green-500" : "bg-red-500")} />
              {health?.status === "ok" ? "System Online" : "System Offline"}
            </div>
          </div>
        </div>
        <nav className="flex-1 p-4 flex flex-col gap-2">
          {nav.map((item) => {
            const Icon = item.icon;
            const isActive = location === item.href;
            return (
              <Link key={item.href} href={item.href} className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-md transition-colors text-sm font-medium",
                isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              )} data-testid={`nav-${item.label.toLowerCase()}`}>
                <Icon className="w-4 h-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <main className="flex-1 overflow-auto">
        <div className="h-full p-8 max-w-5xl mx-auto">
          {children}
        </div>
      </main>
    </div>
  );
}
