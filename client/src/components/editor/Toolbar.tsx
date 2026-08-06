import { Camera, CircleStop, FlaskConical, Pause, Play, Save, StepForward, GitBranch, Box } from "lucide-react";
import { Button } from "../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import type { PieRuntime } from "../../lib/pie";
import type { PieState } from "../../lib/pie";

interface ToolbarProps {
  runtime: PieRuntime | null;
  pieState: PieState;
  captureEvery: number;
  onCaptureEveryChange: (value: number) => void;
  onRunTests: () => void;
  onSave: () => void;
  onCheckpoint: () => void;
  onAddEntity: () => void;
}

export function Toolbar({
  runtime,
  pieState,
  captureEvery,
  onCaptureEveryChange,
  onRunTests,
  onSave,
  onCheckpoint,
  onAddEntity,
}: ToolbarProps) {
  const running = pieState === "running";
  return (
    <div className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto whitespace-nowrap border-b border-white/5 bg-[#0b0b0b] px-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Play" disabled={running || !runtime} onClick={() => runtime?.start()}>
            <Play className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Play</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Pause" disabled={!running} onClick={() => runtime?.pause()}>
            <Pause className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Pause</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Step" disabled={running || !runtime} onClick={() => runtime?.stepOnce()}>
            <StepForward className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Step one frame</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Stop" disabled={!runtime} onClick={() => runtime?.stop()}>
            <CircleStop className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Stop PIE</TooltipContent>
      </Tooltip>
      <span className="mx-2 h-5 w-px bg-border" />
      <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        <Camera className="h-3.5 w-3.5" />
        <span className="hidden text-[10px] tracking-[0.12em] text-[#616161] lg:inline">Capture every</span>
        <Select value={String(captureEvery)} onValueChange={(value) => onCaptureEveryChange(Number(value))}>
          <SelectTrigger className="h-7 w-16 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="3">3 frames</SelectItem>
            <SelectItem value="4">4 frames</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <span className="mx-2 h-5 w-px bg-border" />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Run tests" onClick={onRunTests}>
            <FlaskConical className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Run tests</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Add entity" onClick={onAddEntity}>
            <Box className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Add entity</TooltipContent>
      </Tooltip>
      <div className="flex-1" />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Checkpoint" onClick={onCheckpoint}>
            <GitBranch className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Checkpoint project</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="secondary" size="sm" className="calicode-button" aria-label="Save" onClick={onSave}>
            <Save className="h-3.5 w-3.5" />
            <span className="hidden md:inline">Save</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Save project to core</TooltipContent>
      </Tooltip>
    </div>
  );
}
