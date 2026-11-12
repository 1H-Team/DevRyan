//! Address checks: the front binds to and connects to loopback only.

use std::net::{IpAddr, SocketAddr};

/// True for 127.0.0.0/8 and ::1. The front binds and connects only there:
/// behind any front every request looks local to the server.
pub fn is_loopback(address: &SocketAddr) -> bool {
    match address.ip() {
        IpAddr::V4(ip) => ip.is_loopback(),
        IpAddr::V6(ip) => ip.is_loopback() || ip.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback()),
    }
}

pub fn parse_loopback(text: &str, what: &str) -> Result<SocketAddr, String> {
    let address: SocketAddr = text.parse().map_err(|_| format!("{what} {text:?} is not an address such as 127.0.0.1:4000"))?;
    if !is_loopback(&address) {
        return Err(format!(
            "{what} {address} is not a loopback address; the front only binds to and forwards to 127.0.0.0/8 or ::1"
        ));
    }
    Ok(address)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_loopback_addresses_are_accepted() {
        assert!(parse_loopback("127.0.0.1:0", "listen").is_ok());
        assert!(parse_loopback("[::1]:80", "listen").is_ok());
        assert!(parse_loopback("0.0.0.0:80", "listen").is_err());
        assert!(parse_loopback("192.168.1.2:80", "listen").is_err());
        assert!(parse_loopback("[::]:80", "listen").is_err());
    }
}
