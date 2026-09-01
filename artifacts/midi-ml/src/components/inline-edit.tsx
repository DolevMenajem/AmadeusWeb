import { useState, useRef, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetJobQueryKey, getListJobsQueryKey } from "@workspace/api-client-react";
import { Pencil, Check, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface InlineEditProps {
  jobId: number | string; // <-- Supports both DB numbers and "live-123" strings
  initialValue: string;
  onSave?: (newValue: string) => Promise<void>; // <-- Optional override for Live Jams
}

export function InlineEdit({ jobId, initialValue, onSave }: InlineEditProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [value, setValue] = useState(initialValue);
  const [isSaving, setIsSaving] = useState(false);
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isEditing]);

  const handleSave = async () => {
    if (value.trim() === "" || value === initialValue) {
      setIsEditing(false);
      setValue(initialValue);
      return;
    }

    setIsSaving(true);
    try {
      if (onSave) {
        // Use custom local storage save if provided (for Live Jams)
        await onSave(value);
      } else {
        // Otherwise, hit the normal backend DB route
        await fetch(`/api/jobs/${jobId}/rename`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ newFilename: value }),
        });
        queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId as number) });
        queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
      }
      setIsEditing(false);
    } catch (e) {
      console.error("Failed to rename job", e);
    } finally {
      setIsSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation(); // Prevents parent from catching keyboard events
    if (e.key === "Enter") handleSave();
    if (e.key === "Escape") {
      setIsEditing(false);
      setValue(initialValue);
    }
  };

  if (isEditing) {
    return (
      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <Input 
          ref={inputRef}
          value={value} 
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onClick={(e) => e.stopPropagation()} // Prevents cursor clicks from bubbling
          className="h-7 py-1 px-2 text-sm w-[150px] bg-background"
          disabled={isSaving}
        />
        <Button 
          size="icon" 
          variant="ghost" 
          className="h-7 w-7 text-green-500 hover:text-green-600 hover:bg-green-500/10" 
          onClick={(e) => { 
            e.stopPropagation(); 
            handleSave(); 
          }} 
          disabled={isSaving}
        >
          <Check className="w-3 h-3" />
        </Button>
        <Button 
          size="icon" 
          variant="ghost" 
          className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10" 
          onClick={(e) => { 
            e.stopPropagation(); 
            setIsEditing(false); 
            setValue(initialValue); 
          }} 
          disabled={isSaving}
        >
          <X className="w-3 h-3" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 group" onClick={(e) => e.stopPropagation()}>
      <span className="font-medium truncate max-w-[200px]" title={initialValue}>
        {initialValue}
      </span>
      <Button 
        variant="ghost" 
        size="icon" 
        className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity" 
        onClick={(e) => { 
          e.stopPropagation(); 
          setIsEditing(true); 
        }}
      >
        <Pencil className="w-3 h-3 text-muted-foreground" />
      </Button>
    </div>
  );
}