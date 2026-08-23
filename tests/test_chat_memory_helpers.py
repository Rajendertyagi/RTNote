"""Pure helpers in app.chat.memory."""
from app.chat.memory import is_similar, normalize_text, quote_fts_token, tokens_from_text


def test_normalize_text_collapses_whitespace():
    assert normalize_text("  hello   world \n\t again ") == "hello world again"
    assert normalize_text("") == ""
    assert normalize_text("   ") == ""


def test_tokens_from_text_lowercases_and_skips_single_chars():
    assert tokens_from_text("I like Rust42 and a C") == ["like", "rust42", "and"]
    assert tokens_from_text("!!!") == []
    assert tokens_from_text("Don't stop") == ["don", "stop"]


def test_quote_fts_token_handles_embedded_quotes():
    assert quote_fts_token("plain") == '"plain"'
    assert quote_fts_token('say "hi"') == '"say ""hi"""'


def test_is_similar_threshold():
    assert is_similar("hello world", "hello world")
    assert is_similar("hello world", "hello worlds")  # ratio ~0.95
    assert not is_similar("completely different text", "hello world", threshold=0.9)
