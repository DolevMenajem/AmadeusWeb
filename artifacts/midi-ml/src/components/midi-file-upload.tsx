import { useRef, useState } from "react";
import { Upload, FileMusic, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface MidiFileUploadProps {
  onFileSelect: (file: File | null) => void;
  selectedFile: File | null;
  disabled?: boolean;
}

export function MidiFileUpload({ onFileSelect, selectedFile, disabled }: MidiFileUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    onFileSelect(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (disabled) return;
    const file = e.dataTransfer.files?.[0];
    if (file && (file.name.endsWith(".mid") || file.name.endsWith(".midi"))) {
      onFileSelect(file);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!disabled) setIsDragging(true);
  };

  const handleDragLeave = () => setIsDragging(false);

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onFileSelect(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div
      onClick={() => !disabled && inputRef.current?.click()}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      data-testid="midi-file-upload"
      className={cn(
        "relative flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-6 transition-all cursor-pointer select-none",
        isDragging
          ? "border-primary bg-primary/10"
          : selectedFile
          ? "border-primary/50 bg-primary/5"
          : "border-border hover:border-primary/50 hover:bg-secondary/30",
        disabled && "opacity-50 cursor-not-allowed"
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".mid,.midi"
        className="hidden"
        onChange={handleFileChange}
        disabled={disabled}
        data-testid="input-file"
      />

      {selectedFile ? (
        <div className="flex items-center gap-3 w-full">
          <div className="w-10 h-10 rounded-md bg-primary/20 flex items-center justify-center shrink-0">
            <FileMusic className="w-5 h-5 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate text-foreground">{selectedFile.name}</p>
            <p className="text-xs text-muted-foreground">{(selectedFile.size / 1024).toFixed(1)} KB</p>
          </div>
          <button
            onClick={handleClear}
            className="w-7 h-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            data-testid="button-clear-file"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <>
          <div className="w-10 h-10 rounded-md bg-secondary flex items-center justify-center">
            <Upload className="w-5 h-5 text-muted-foreground" />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium text-foreground">Drop a MIDI file or click to browse</p>
            <p className="text-xs text-muted-foreground mt-1">Accepts .mid and .midi files up to 10 MB</p>
          </div>
        </>
      )}
    </div>
  );
}
