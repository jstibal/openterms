"""OpenTerms adapter for LangChain.

Provides :class:`OpenTermsCallbackHandler` — a LangChain ``BaseCallbackHandler``
that signs and posts an ORS v0.1 receipt for every tool invocation.

LangChain compatibility window: ``langchain-core>=0.3,<1.0``. The handler uses
only the public ``on_tool_start`` / ``on_tool_end`` / ``on_tool_error`` hooks,
which have been stable through the 0.3 line.
"""

from openterms_langchain.handler import OpenTermsCallbackHandler

__all__ = ["OpenTermsCallbackHandler"]
__version__ = "0.5.0"
