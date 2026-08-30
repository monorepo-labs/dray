//! pi, over `pi --mode rpc`.
//!
//! One child per session, speaking LF-delimited JSON in both directions. See
//! `apps/desktop/PI-PLAN.md` for the design, the rejected alternatives and the
//! captured protocol the parser was written against.

pub mod parser;
