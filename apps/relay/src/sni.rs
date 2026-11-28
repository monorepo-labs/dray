//! Reads a TLS ClientHello's server name and nothing more: the relay routes
//! on it and passes every byte, the hello included, through untouched.

use tokio::io::{AsyncRead, AsyncReadExt};

/// A record holds at most 16 KiB plus its header; a hello is one record in
/// practice, post-quantum key shares included (~1.8 KiB).
const MAX_RECORD: usize = 5 + 16 * 1024;

/// Reads the first TLS record off `stream`, answering what was read (to be
/// sent on first) and the SNI, lowercased.
pub async fn read_hello<S: AsyncRead + Unpin>(stream: &mut S) -> Result<(Vec<u8>, String), String> {
    let mut buf = vec![0u8; 5];
    stream.read_exact(&mut buf).await.map_err(|e| format!("read: {e}"))?;
    if buf[0] != 0x16 {
        return Err("not TLS".into());
    }
    let len = u16::from_be_bytes([buf[3], buf[4]]) as usize;
    if 5 + len > MAX_RECORD {
        return Err("record too long".into());
    }
    buf.resize(5 + len, 0);
    stream.read_exact(&mut buf[5..]).await.map_err(|e| format!("read: {e}"))?;
    let sni = server_name(&buf[5..]).ok_or("no server name")?;
    Ok((buf, sni.to_ascii_lowercase()))
}

/// The `server_name` extension of a handshake message holding a ClientHello.
fn server_name(msg: &[u8]) -> Option<String> {
    let mut r = Reader(msg);
    if r.u8()? != 1 {
        return None;
    }
    let n = r.u24()?;
    let body = r.take(n)?;
    let mut r = Reader(body);
    r.take(2 + 32)?; // version, random
    let n = r.u8()? as usize;
    r.take(n)?; // session id
    let n = r.u16()? as usize;
    r.take(n)?; // cipher suites
    let n = r.u8()? as usize;
    r.take(n)?; // compression
    let mut exts = Reader(r.vec16()?);
    while !exts.0.is_empty() {
        let kind = exts.u16()?;
        let data = exts.vec16()?;
        if kind != 0 {
            continue;
        }
        let mut list = Reader(data);
        let mut names = Reader(list.vec16()?);
        while !names.0.is_empty() {
            let name_type = names.u8()?;
            let name = names.vec16()?;
            if name_type == 0 {
                return String::from_utf8(name.to_vec()).ok();
            }
        }
    }
    None
}

struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        if self.0.len() < n {
            return None;
        }
        let (head, rest) = self.0.split_at(n);
        self.0 = rest;
        Some(head)
    }
    fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|b| b[0])
    }
    fn u16(&mut self) -> Option<u16> {
        self.take(2).map(|b| u16::from_be_bytes([b[0], b[1]]))
    }
    /// A field behind a two-byte length.
    fn vec16(&mut self) -> Option<&'a [u8]> {
        let n = self.u16()? as usize;
        self.take(n)
    }
    fn u24(&mut self) -> Option<usize> {
        self.take(3).map(|b| u32::from_be_bytes([0, b[0], b[1], b[2]]) as usize)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A ClientHello naming `a.b.relay.localhost`, built by hand to the RFC
    /// 8446 layout with one other extension before SNI.
    fn hello(name: &str) -> Vec<u8> {
        let mut sni = vec![];
        let entry = [&[0u8][..], &(name.len() as u16).to_be_bytes(), name.as_bytes()].concat();
        sni.extend_from_slice(&(entry.len() as u16).to_be_bytes());
        sni.extend_from_slice(&entry);
        let mut exts = vec![0x00, 0x0a, 0x00, 0x02, 0x00, 0x00];
        exts.extend_from_slice(&[0, 0]);
        exts.extend_from_slice(&(sni.len() as u16).to_be_bytes());
        exts.extend_from_slice(&sni);
        let mut body = vec![3, 3];
        body.extend_from_slice(&[7; 32]);
        body.extend_from_slice(&[0, 0, 2, 0x13, 0x01, 1, 0]);
        body.extend_from_slice(&(exts.len() as u16).to_be_bytes());
        body.extend_from_slice(&exts);
        let mut msg = vec![1];
        msg.extend_from_slice(&(body.len() as u32).to_be_bytes()[1..]);
        msg.extend_from_slice(&body);
        let mut rec = vec![0x16, 3, 1];
        rec.extend_from_slice(&(msg.len() as u16).to_be_bytes());
        rec.extend_from_slice(&msg);
        rec
    }

    #[tokio::test]
    async fn reads_the_name_and_keeps_the_bytes() {
        let raw = hello("A.B.relay.localhost");
        let mut extra = raw.clone();
        extra.extend_from_slice(b"after");
        let mut stream = &extra[..];
        let (read, sni) = read_hello(&mut stream).await.unwrap();
        assert_eq!(sni, "a.b.relay.localhost");
        assert_eq!(read, raw, "the whole record, to pass on");
        assert_eq!(stream, b"after", "nothing past it read");
    }

    #[tokio::test]
    async fn refuses_what_is_not_a_hello() {
        let mut http = &b"GET / HTTP/1.1\r\n\r\n"[..];
        assert!(read_hello(&mut http).await.is_err());
        let mut cut = &hello("x.y.z")[..20];
        assert!(read_hello(&mut cut).await.is_err());
    }
}
