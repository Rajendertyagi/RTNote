"""
chat_memory.py
Lightweight memory layer for LiteLLM-powered chat.
Combines raw chat history (ChatSession) with extracted memories (Memory).
Uses SQLite FTS5 for memory retrieval (configured via Alembic migration).
"""

import asyncio
import json
import logging
import re
from datetime import datetime, timezone
from difflib import SequenceMatcher
from typing import List, Optional

from sqlalchemy import Column, Integer, String, Text, DateTime, UniqueConstraint, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from litellm import acompletion

# Shared DB objects
from app.chat.db import Base, AsyncSessionLocal

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)


# ---------- Models ----------
class ChatSession(Base):
    __tablename__ = "chat_sessions"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String(255), default="New Chat")
    messages = Column(Text, default="[]")
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class Memory(Base):
    __tablename__ = "memories"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String(100), default="local_user", index=True, nullable=False)
    memory_text = Column(Text, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    __table_args__ = (UniqueConstraint("user_id", "memory_text", name="uq_user_memory"),)


# ---------- Helpers ----------
def normalize_text(s: str) -> str:
    """Collapse whitespace and strip."""
    return re.sub(r"\s+", " ", s).strip()


def tokens_from_text(s: str) -> List[str]:
    """Extract lowercase word tokens for FTS matching."""
    return [t.lower() for t in re.findall(r"\w+", s) if len(t) > 1]


def quote_fts_token(tok: str) -> str:
    """Properly quote an FTS5 token to avoid syntax errors."""
    return '"' + tok.replace('"', '""') + '"'


def is_similar(a: str, b: str, threshold: float = 0.9) -> bool:
    """Quick fuzzy similarity check."""
    return SequenceMatcher(None, a, b).ratio() >= threshold


# ---------- Memory Manager ----------
class MemoryManager:
    """
    Manages chat sessions and extracted memories.

    Responsibilities:
    - Persist chat sessions (ChatSession.messages JSON).
    - Extract short, non-sensitive memories from recent conversation.
    - Store memories with DB-level uniqueness and optional fuzzy dedupe.
    - Retrieve relevant memories via SQLite FTS5 (with LIKE fallback).
    """

    def __init__(
        self,
        db: AsyncSession,
        session_id: Optional[int] = None,
        user_id: str = "local_user",
        system_prompt: str = "You are a helpful assistant.",
        model: str = "gpt-4o-mini",
        memory_model: str = "gpt-4o-mini",
        memory_limit: int = 5,
        auto_extract: bool = True,
        extraction_timeout: int = 20,
    ):
        self.db = db
        self.session_id = session_id
        self.user_id = user_id
        self.system_prompt = system_prompt
        self.model = model
        self.memory_model = memory_model
        self.memory_limit = memory_limit
        self.auto_extract = auto_extract
        self.extraction_timeout = extraction_timeout
        self.messages: List[dict] = []

    # ----------------- Session loading / messages -----------------
    async def load_session(self):
        """Load an existing session or initialize a new one."""
        if self.session_id:
            res = await self.db.execute(select(ChatSession).where(ChatSession.id == self.session_id))
            session = res.scalar_one_or_none()
            if session:
                try:
                    self.messages = json.loads(session.messages)
                except Exception:
                    self.messages = []
                if self.system_prompt and (not self.messages or self.messages[0].get("role") != "system"):
                    self.messages.insert(0, {"role": "system", "content": self.system_prompt})
                return self
        # New session
        self.messages = [{"role": "system", "content": self.system_prompt}] if self.system_prompt else []
        return self

    async def add_user_message(self, content: str):
        """Append a user message to the in-memory conversation buffer."""
        self.messages.append({"role": "user", "content": content})

    # ----------------- Main response flow -----------------
    async def get_response(self) -> str:
        """
        Generate assistant reply, persist session, and schedule memory extraction.
        This method returns quickly; extraction runs in background.
        """
        # 1. Retrieve relevant memories and augment system prompt
        if self.messages:
            last_user = None
            for m in reversed(self.messages):
                if m.get("role") == "user":
                    last_user = m.get("content")
                    break
            if last_user:
                try:
                    memories = await self._search_memories(last_user)
                except Exception:
                    logger.exception("Memory search failed")
                    memories = []
                if memories:
                    memory_context = "\n".join(f"- {m}" for m in memories)
                    if self.messages and self.messages[0].get("role") == "system":
                        self.messages[0]["content"] = (
                            self.system_prompt + "\n\nRelevant past facts:\n" + memory_context
                        )
                    else:
                        self.messages.insert(
                            0,
                            {
                                "role": "system",
                                "content": self.system_prompt + "\n\nRelevant past facts:\n" + memory_context,
                            },
                        )

        # 2. Call LLM (async, with timeout)
        try:
            response = await asyncio.wait_for(
                acompletion(
                    model=self.model,
                    messages=self.messages,
                    temperature=0.2,
                ),
                timeout=60,
            )
            assistant_reply = response.choices[0].message.content
        except asyncio.TimeoutError:
            logger.exception("LLM call timed out")
            assistant_reply = "Sorry, I couldn't generate a response right now due to a timeout."
        except Exception:
            logger.exception("LLM call failed")
            assistant_reply = "Sorry, I had trouble generating a response right now."

        # 3. Append assistant reply and save session
        self.messages.append({"role": "assistant", "content": assistant_reply})
        await self._save()

        # 4. Schedule memory extraction in background (non-blocking)
        if self.auto_extract:
            recent = self.messages[-8:]
            # Run extraction in background using a fresh DB session to avoid interfering with request DB session
            asyncio.create_task(self._extract_memories_background(recent))

        return assistant_reply

    # ----------------- Background extraction -----------------
    async def _extract_memories_background(self, recent_messages: List[dict]):
        """Run extraction in a separate task, using a fresh DB session."""
        try:
            async with AsyncSessionLocal() as db:
                extractor = MemoryManager(db=db, user_id=self.user_id, memory_model=self.memory_model)
                await asyncio.wait_for(
                    extractor._extract_memories(recent_messages),
                    timeout=self.extraction_timeout,
                )
        except asyncio.TimeoutError:
            logger.exception("Memory extraction timed out")
        except Exception:
            logger.exception("Background memory extraction failed")

    async def _extract_memories(self, recent_messages: Optional[List[dict]] = None):
        """Extract important facts from recent conversation and store as memories."""
        if not recent_messages:
            recent_messages = self.messages[-8:]
        if len(recent_messages) < 2:
            return

        prompt = (
            "Extract important, non-sensitive facts, preferences, or recurring topics from this conversation.\n"
            "Return a JSON object with key 'memories' containing a list of short strings.\n"
            "Do not include PII, passwords, or sensitive personal data. If nothing important, return {\"memories\": []}.\n\n"
            "Conversation:\n"
        )
        prompt += "\n".join(f"{m.get('role')}: {m.get('content')}" for m in recent_messages)

        try:
            resp = await acompletion(
                model=self.memory_model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.0,
            )
            raw = resp.choices[0].message.content

            # Robust JSON extraction
            try:
                data = json.loads(raw)
            except Exception:
                m = re.search(r"\{.*\}", raw, flags=re.S)
                if not m:
                    logger.warning("No JSON found in extraction response")
                    return
                data = json.loads(m.group(0))

            memories = data.get("memories", [])
            for mem in memories:
                if not isinstance(mem, str):
                    continue
                mem_text = normalize_text(mem)
                if len(mem_text) < 10:
                    continue
                # Basic PII filter
                if re.search(r"\b(password|ssn|credit|card|bank)\b", mem_text, flags=re.I):
                    continue
                await self._maybe_add_memory(mem_text)
        except Exception:
            logger.exception("Memory extraction failed")

    # ----------------- Memory storage -----------------
    async def _maybe_add_memory(self, memory_text: str):
        """Add memory with deduplication (unique constraint + optional similarity check)."""
        memory_text = normalize_text(memory_text)
        if not memory_text:
            return

        # Optional fuzzy check first (uncomment if desired and acceptable cost)
        # existing = await self.list_memories()
        # if any(is_similar(m, memory_text) for m in existing):
        #     logger.debug("Memory too similar to existing one; skipping")
        #     return

        # Insert with DB-level unique constraint handling
        try:
            async with self.db.begin():
                mem = Memory(user_id=self.user_id, memory_text=memory_text)
                self.db.add(mem)
                await self.db.flush()  # will raise IntegrityError if duplicate
        except IntegrityError:
            logger.debug("Memory already exists (unique constraint)")
            try:
                await self.db.rollback()
            except Exception:
                pass
        except Exception:
            logger.exception("Failed to add memory")
            try:
                await self.db.rollback()
            except Exception:
                pass

    # ----------------- Memory search -----------------
    async def _search_memories(self, query: str) -> List[str]:
        """Search memories using FTS5 with fallback to LIKE."""
        if not query:
            return []

        tokens = tokens_from_text(query)
        if not tokens:
            return []

        # Properly quote each token for FTS5
        match_expr = " AND ".join(quote_fts_token(t) for t in tokens)

        sql = text(
            """
            SELECT m.memory_text
            FROM memories_fts
            JOIN memories m ON m.id = memories_fts.rowid
            WHERE memories_fts MATCH :match_expr
            ORDER BY bm25(memories_fts)
            LIMIT :limit
            """
        )
        try:
            result = await self.db.execute(sql, {"match_expr": match_expr, "limit": self.memory_limit})
            rows = result.fetchall()
            return [r[0] for r in rows]
        except Exception:
            logger.debug("FTS search failed; falling back to LIKE")
            # Improved fallback: AND of individual LIKE conditions
            conditions = []
            params = {"user_id": self.user_id, "limit": self.memory_limit}
            for i, tok in enumerate(tokens):
                param_name = f"tok{i}"
                conditions.append(f"memory_text LIKE :{param_name}")
                params[param_name] = f"%{tok}%"
            where_clause = " AND ".join(conditions) if conditions else "1=1"
            fallback_sql = text(
                f"""
                SELECT memory_text
                FROM memories
                WHERE user_id = :user_id AND ({where_clause})
                LIMIT :limit
                """
            )
            result = await self.db.execute(fallback_sql, params)
            return [r[0] for r in result.fetchall()]

    # ----------------- Session persistence -----------------
    async def _save(self):
        """Persist the chat session (create or update)."""
        try:
            if not self.session_id:
                title = self.messages[1]["content"][:50] if len(self.messages) > 1 else "New Chat"
                new_session = ChatSession(title=title, messages=json.dumps(self.messages))
                async with self.db.begin():
                    self.db.add(new_session)
                # refresh to obtain id
                await self.db.refresh(new_session)
                self.session_id = new_session.id
            else:
                session = await self.db.get(ChatSession, self.session_id)
                if session:
                    session.messages = json.dumps(self.messages)
                    session.updated_at = datetime.now(timezone.utc)
                    async with self.db.begin():
                        self.db.add(session)
        except Exception:
            logger.exception("Failed to save session")
            try:
                await self.db.rollback()
            except Exception:
                pass

    # ----------------- Utilities -----------------
    async def clear(self):
        """Clear current session messages."""
        self.messages = [{"role": "system", "content": self.system_prompt}] if self.system_prompt else []
        await self._save()

    async def list_memories(self) -> List[str]:
        """Return all memories for the current user."""
        try:
            res = await self.db.execute(select(Memory.memory_text).where(Memory.user_id == self.user_id))
            return [r[0] for r in res.fetchall()]
        except Exception:
            logger.exception("Failed to list memories")
            return []
