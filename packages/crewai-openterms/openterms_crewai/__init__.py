"""OpenTerms adapter for CrewAI.

CrewAI compatibility note. CrewAI's ``BaseTool`` API has changed repeatedly
across the 0.x line (the constructor signature, the ``_run`` vs ``run`` hook,
and pydantic model nuances have all shifted). This adapter therefore wraps a
*callable* — the function-tool pattern, which is the stable surface across
CrewAI versions. The exported helpers are:

* :func:`wrap_tool` — wraps any callable so each invocation emits a signed
  receipt before delegating to the original. Works with CrewAI's
  ``Tool(name=..., func=...)`` constructor, with the ``@tool`` decorator, and
  with custom ``BaseTool`` subclasses (just pass ``self._run`` to wrap).
* :func:`openterms_tool` — decorator form of :func:`wrap_tool`.

If you need a ``BaseTool`` subclass with the receipt emission baked in, build
one in your application code that calls into a ``wrap_tool``-produced callable
from inside ``_run``. See ``examples/quickstart.py``.
"""

from openterms_crewai.wrapper import (
    OpenTermsToolConfig,
    openterms_tool,
    wrap_tool,
)

__all__ = ["OpenTermsToolConfig", "openterms_tool", "wrap_tool"]
__version__ = "0.5.0"
