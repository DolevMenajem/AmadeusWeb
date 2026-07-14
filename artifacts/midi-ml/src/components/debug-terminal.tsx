"use client";

import { useEffect, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Terminal as TerminalIcon } from "lucide-react";

interface DebugTerminalProps {
  logs: string[];
}

export function DebugTerminal({ logs }: DebugTerminalProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the bottom whenever a new log arrives
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <div className="w-full h-48 bg-black rounded-lg border border-primary/30 overflow-hidden flex flex-col shadow-inner">
      <div className="bg-zinc-900 px-3 py-1.5 border-b border-zinc-800 flex items-center gap-2">
        <TerminalIcon className="w-4 h-4 text-zinc-400" />
        <span className="text-xs font-mono text-zinc-400 font-semibold tracking-wider">SYSTEM LOGS</span>
      </div>
      <ScrollArea className="flex-1 p-3" viewportRef={scrollRef}>
        <div className="font-mono text-[11px] leading-relaxed tracking-tight space-y-1">
          {logs.length === 0 ? (
            <div className="text-zinc-600 italic">Waiting for system events...</div>
          ) : (
            logs.map((log, i) => {
              // Color code the logs based on their prefix for that authentic terminal feel
              let colorClass = "text-zinc-300";
              if (log.includes("[SYS]")) colorClass = "text-blue-400";
              if (log.includes("[NET]")) colorClass = "text-purple-400";
              if (log.includes("[AI]")) colorClass = "text-green-400";
              if (log.includes("[ERR]")) colorClass = "text-red-400";

              return (
                <div key={i} className={`${colorClass} break-all`}>
                  {log}
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>
    </div>
  );
}