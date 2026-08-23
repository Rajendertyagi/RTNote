"""
chat_routes.py
FastAPI router for chat functionality powered by LiteLLM and MemoryManager.
Includes endpoints for sending messages, managing sessions, and listing memories.
"""

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from typing import Optional, List

from app.chat.db import AsyncSessionLocal  # your async session factory
from app.chat.memory import MemoryManager, ChatSession, Memory
from pydantic import BaseModel, Field

import json

router = APIRouter(prefix="/api/chat", tags=["chat"])


# ---------- Pydantic Schemas ----------
class AttachmentIn(BaseModel):
    filename: str = "file"
    content: str = ""


class SendMessageRequest(BaseModel):
    message: str = Field(..., min_length=1)
    session_id: Optional[int] = None
    model: str = "gpt-4o-mini"
    system_prompt: Optional[str] = "You are a helpful assistant."
    reasoning_effort: Optional[str] = None
    attachments: Optional[List[AttachmentIn]] = None


class SendMessageResponse(BaseModel):
    session_id: int
    reply: str


class SessionOut(BaseModel):
    id: int
    title: str
    updated_at: Optional[str]
    created_at: Optional[str]


class HistoryOut(BaseModel):
    session_id: int
    messages: List[dict]


class MemoriesOut(BaseModel):
    user_id: str
    memories: List[str]


# ---------- Dependencies ----------
async def get_db():
    async with AsyncSessionLocal() as session:
        yield session


# ---------- Routes ----------
@router.post("/send", response_model=SendMessageResponse, status_code=status.HTTP_200_OK)
async def send_message(
    request: SendMessageRequest,
    db: AsyncSession = Depends(get_db),
):
    """
    Send a message to the LLM and get a reply.
    If session_id is provided, continue that conversation; otherwise create a new session.
    """
    manager = MemoryManager(
        db=db,
        session_id=request.session_id,
        system_prompt=request.system_prompt,
        model=request.model,
        reasoning_effort=request.reasoning_effort,
        attachments=[a.model_dump() for a in (request.attachments or [])],
    )
    await manager.load_session()
    await manager.add_user_message(request.message)

    # Generate reply (manager handles saving and background extraction)
    reply = await manager.get_response()

    # session_id should be set after save
    if not manager.session_id:
        raise HTTPException(status_code=500, detail="Failed to create or persist chat session")

    return SendMessageResponse(session_id=manager.session_id, reply=reply)


@router.post("/stream")
async def stream_message(request: SendMessageRequest, db: AsyncSession = Depends(get_db)):
    """Stream the assistant reply as Server-Sent Events.

    Events:
      data: {"type": "meta",  "session_id": N}   — sent first
      data: {"type": "delta", "text": "..."}     — repeated text chunks
      data: {"type": "done"}                     — final event
    """
    manager = MemoryManager(
        db=db,
        session_id=request.session_id,
        system_prompt=request.system_prompt,
        model=request.model,
        reasoning_effort=request.reasoning_effort,
        attachments=[a.model_dump() for a in (request.attachments or [])],
    )
    await manager.load_session()
    await manager.add_user_message(request.message)
    session_id = await manager.ensure_session()
    if not session_id:
        raise HTTPException(status_code=500, detail="Failed to create or persist chat session")

    async def event_stream():
        yield f"data: {json.dumps({'type': 'meta', 'session_id': session_id})}\n\n"
        async for delta in manager.stream_response():
            yield f"data: {json.dumps({'type': 'delta', 'text': delta})}\n\n"
        yield f"data: {json.dumps({'type': 'done'})}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/sessions", response_model=List[SessionOut])
async def list_sessions(
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    """List chat sessions ordered by last update (most recent first)."""
    result = await db.execute(
        select(ChatSession).order_by(ChatSession.updated_at.desc()).limit(limit)
    )
    sessions = result.scalars().all()
    return [
        SessionOut(
            id=s.id,
            title=s.title,
            updated_at=s.updated_at.isoformat() if s.updated_at else None,
            created_at=s.created_at.isoformat() if s.created_at else None,
        )
        for s in sessions
    ]


@router.get("/history/{session_id}", response_model=HistoryOut)
async def get_history(session_id: int, db: AsyncSession = Depends(get_db)):
    """Return the full message history of a session."""
    # Verify session exists first
    session = await db.get(ChatSession, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    manager = MemoryManager(db=db, session_id=session_id)
    await manager.load_session()
    return HistoryOut(session_id=session_id, messages=manager.messages)


@router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_session(session_id: int, db: AsyncSession = Depends(get_db)):
    """Delete a chat session and all its messages."""
    session = await db.get(ChatSession, session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    # Use a transaction for safety
    await db.execute(delete(ChatSession).where(ChatSession.id == session_id))
    await db.commit()
    return None


@router.get("/memories", response_model=MemoriesOut)
async def list_memories(user_id: str = "local_user", db: AsyncSession = Depends(get_db)):
    """Return all stored memories for a user (default local_user)."""
    manager = MemoryManager(db=db, user_id=user_id)
    memories = await manager.list_memories()
    return MemoriesOut(user_id=user_id, memories=memories)


@router.delete("/memories/{memory_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_memory(memory_id: int, db: AsyncSession = Depends(get_db)):
    """Delete a single memory by its ID."""
    mem = await db.get(Memory, memory_id)
    if not mem:
        raise HTTPException(status_code=404, detail="Memory not found")
    await db.delete(mem)
    await db.commit()
    return None
