import type { PinterestBoard } from "@/lib/pinterestClient";
import type { BoardContext } from "./types";

export function getBoardContext(boardId: string, boardName: string, boards: PinterestBoard[]): BoardContext {
  const board = boards.find(b => b.id === boardId);
  return {
    boardId: board?.id || boardId || undefined,
    boardName: board?.name || boardName || undefined,
    boardDescription: board?.description,
  };
}
