//! Certificates for servers' addresses. A server sends a CSR for
//! `*.<id>.<zone>` over its authenticated bridge and keeps the private key;
//! the relay gets it signed and hands back the chain. The relay can then
//! never read a visitor's traffic, only route it.
//!
//! In production that is Let's Encrypt over DNS-01, the TXT record written
//! through Cloudflare's API (drayhq.com's DNS is there). DNS-01 because the
//! visitor door is Railway's TCP proxy, on a port of Railway's choosing, and
//! HTTP-01 and TLS-ALPN-01 only ever knock on 80 and 443. For tests, a local
//! CA whose certificate the client is told to trust.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rcgen::{CertificateParams, CertificateSigningRequestParams, KeyPair, SanType};

use crate::log;

pub enum Issuer {
    Dev(Dev),
    Acme(Box<Acme>),
    /// No way to issue: servers already holding a certificate still work.
    None,
}

/// How often one server may ask, and all of them together: Let's Encrypt
/// allows 50 new certificates a week per registered domain, drayhq.com's
/// own included.
const PER_SERVER_PER_DAY: usize = 5;
const ALL_PER_HOUR: usize = 20;

#[derive(Default)]
pub struct Limits {
    in_flight: HashSet<String>,
    by_server: HashMap<String, Vec<Instant>>,
    all: Vec<Instant>,
}

pub struct Issuing {
    pub issuer: Issuer,
    limits: Mutex<Limits>,
}

impl Issuing {
    pub fn new(issuer: Issuer) -> Self {
        Self { issuer, limits: Mutex::default() }
    }

    /// Signs `csr` for `hostname` (`<id>.<zone>`), within the limits above.
    pub async fn issue(&self, id: &str, hostname: &str, csr: &str) -> Result<String, String> {
        let (csr, der) = check_csr(hostname, csr)?;
        self.admit(id)?;
        let started = Instant::now();
        let issued = match &self.issuer {
            Issuer::Dev(dev) => dev.sign(&csr),
            Issuer::Acme(acme) => acme.issue(hostname, &der).await,
            Issuer::None => Err("this relay issues no certificates".into()),
        };
        self.limits.lock().unwrap_or_else(|e| e.into_inner()).in_flight.remove(id);
        match &issued {
            Ok(_) => log!("cert.issued", id = id, after_ms = started.elapsed().as_millis()),
            Err(e) => log!("cert.failed", id = id, after_ms = started.elapsed().as_millis(), reason = e),
        }
        issued
    }

    fn admit(&self, id: &str) -> Result<(), String> {
        let mut limits = self.limits.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        limits.all.retain(|t| now.duration_since(*t) < Duration::from_secs(3600));
        let mine = limits.by_server.entry(id.to_string()).or_default();
        mine.retain(|t| now.duration_since(*t) < Duration::from_secs(86_400));
        if mine.len() >= PER_SERVER_PER_DAY {
            return Err("too many certificates for this server today".into());
        }
        mine.push(now);
        if limits.all.len() >= ALL_PER_HOUR {
            return Err("the relay is issuing too many certificates; try again later".into());
        }
        if !limits.in_flight.insert(id.to_string()) {
            return Err("already issuing for this server".into());
        }
        limits.all.push(now);
        Ok(())
    }
}

/// A CSR naming exactly `*.<hostname>`, its signature checked. Anything else
/// is refused: a server gets its own name and no other.
fn check_csr(hostname: &str, pem: &str) -> Result<(CertificateSigningRequestParams, Vec<u8>), String> {
    let csr = CertificateSigningRequestParams::from_pem(pem).map_err(|e| format!("bad CSR: {e}"))?;
    let (_, der) = x509_parser::pem::parse_x509_pem(pem.as_bytes()).map_err(|e| format!("bad CSR: {e}"))?;
    let want = format!("*.{hostname}");
    match csr.params.subject_alt_names.as_slice() {
        [SanType::DnsName(name)] if name.as_str() == want => Ok((csr, der.contents)),
        other => Err(format!("the CSR must name {want} alone, not {other:?}")),
    }
}

/// A local CA, made on first start in `dir` (`ca.pem`, `ca-key.pem`).
pub struct Dev {
    key: KeyPair,
    params: CertificateParams,
    days: i64,
}

impl Dev {
    pub fn open(dir: PathBuf, days: i64) -> Result<Self, String> {
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let (cert_path, key_path) = (dir.join("ca.pem"), dir.join("ca-key.pem"));
        let key = match std::fs::read_to_string(&key_path) {
            Ok(pem) => KeyPair::from_pem(&pem).map_err(|e| e.to_string())?,
            Err(_) => {
                let key = KeyPair::generate().map_err(|e| e.to_string())?;
                std::fs::write(&key_path, key.serialize_pem()).map_err(|e| e.to_string())?;
                key
            }
        };
        let mut params = CertificateParams::new(Vec::<String>::new()).map_err(|e| e.to_string())?;
        params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        params.distinguished_name.push(rcgen::DnType::CommonName, "Dray relay dev CA");
        params.key_usages = vec![rcgen::KeyUsagePurpose::KeyCertSign, rcgen::KeyUsagePurpose::CrlSign];
        if !cert_path.exists() {
            let cert = params.self_signed(&key).map_err(|e| e.to_string())?;
            std::fs::write(&cert_path, cert.pem()).map_err(|e| e.to_string())?;
        }
        log!("issuer.dev", ca = cert_path.display(), days = days);
        Ok(Self { key, params, days })
    }

    fn sign(&self, csr: &CertificateSigningRequestParams) -> Result<String, String> {
        let mut csr = CertificateSigningRequestParams { params: csr.params.clone(), public_key: csr.public_key.clone() };
        let now = time_now();
        csr.params.not_before = now - time::Duration::hours(1);
        csr.params.not_after = now + time::Duration::days(self.days);
        let issuer = rcgen::Issuer::from_params(&self.params, &self.key);
        csr.signed_by(&issuer).map(|c| c.pem()).map_err(|e| e.to_string())
    }
}

fn time_now() -> time::OffsetDateTime {
    time::OffsetDateTime::now_utc()
}

pub struct AcmeSettings {
    pub directory: String,
    pub credentials: Option<String>,
    /// A PEM root the ACME server's own TLS is checked against, for a test CA.
    pub root_cert: Option<String>,
    pub cf_api: String,
    pub cf_token: String,
    pub cf_zone: String,
    pub doh: Option<String>,
    pub visitor_target: String,
}

/// Let's Encrypt over DNS-01, records through Cloudflare.
pub struct Acme {
    account: instant_acme::Account,
    http: reqwest::Client,
    /// Cloudflare's API, or a stand-in for tests.
    cf_api: String,
    /// Where the TXT record is looked for before Let's Encrypt is told to;
    /// `None` skips the wait, for a test CA reading its own DNS.
    doh: Option<String>,
    cf_token: String,
    cf_zone: String,
    /// What `*.<id>.<zone>` points at: the TCP proxy's host.
    visitor_target: String,
}

impl Acme {
    pub async fn open(settings: AcmeSettings) -> Result<Self, String> {
        use instant_acme::{Account, NewAccount};
        let builder = || match &settings.root_cert {
            Some(pem) => Account::builder_with_root(pem).map_err(|e| e.to_string()),
            None => Account::builder().map_err(|e| e.to_string()),
        };
        let account = match settings.credentials {
            Some(json) => {
                let creds = serde_json::from_str(&json).map_err(|e| format!("ACME_ACCOUNT_JSON: {e}"))?;
                builder()?.from_credentials(creds).await.map_err(|e| e.to_string())?
            }
            // A fresh account each start: allowed (10 per IP per 3 hours), and
            // nothing secret then needs keeping between deploys.
            None => {
                let new = NewAccount { contact: &[], terms_of_service_agreed: true, only_return_existing: false };
                builder()?.create(&new, settings.directory, None).await.map_err(|e| e.to_string())?.0
            }
        };
        log!("issuer.acme", account = account.id());
        Ok(Self {
            account,
            http: reqwest::Client::new(),
            cf_api: settings.cf_api,
            doh: settings.doh,
            cf_token: settings.cf_token,
            cf_zone: settings.cf_zone,
            visitor_target: settings.visitor_target,
        })
    }

    async fn issue(&self, hostname: &str, csr_der: &[u8]) -> Result<String, String> {
        use instant_acme::{AuthorizationStatus, ChallengeType, Identifier, NewOrder, OrderStatus, RetryPolicy};
        // A record of its own, so the TXT below sitting under `<id>.<zone>`
        // cannot hide the name from a zone-wide wildcard.
        self.ensure_cname(&format!("*.{hostname}")).await?;
        let txt_name = format!("_acme-challenge.{hostname}");
        let ids = [Identifier::Dns(format!("*.{hostname}"))];
        let mut order = self.account.new_order(&NewOrder::new(&ids)).await.map_err(|e| format!("order: {e}"))?;
        let mut records = Vec::new();
        let result = async {
            let mut authzs = order.authorizations();
            while let Some(authz) = authzs.next().await {
                let mut authz = authz.map_err(|e| format!("authorization: {e}"))?;
                if authz.status == AuthorizationStatus::Valid {
                    continue;
                }
                let mut challenge = authz.challenge(ChallengeType::Dns01).ok_or("no dns-01 challenge offered")?;
                let value = challenge.key_authorization().dns_value();
                records.push(self.create_txt(&txt_name, &value).await?);
                self.await_txt(&txt_name, &value).await;
                challenge.set_ready().await.map_err(|e| format!("challenge: {e}"))?;
            }
            let retry = RetryPolicy::new().timeout(Duration::from_secs(120));
            match order.poll_ready(&retry).await.map_err(|e| format!("order: {e}"))? {
                OrderStatus::Ready => {}
                status => return Err(format!("order ended {status:?}")),
            }
            order.finalize_csr(csr_der).await.map_err(|e| format!("finalize: {e}"))?;
            order.poll_certificate(&retry).await.map_err(|e| format!("certificate: {e}"))
        }
        .await;
        for id in records {
            self.delete_record(&id).await;
        }
        result
    }

    fn cf(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let url = format!("{}/zones/{}/dns_records{path}", self.cf_api, self.cf_zone);
        self.http.request(method, url).bearer_auth(&self.cf_token)
    }

    async fn cf_json(&self, req: reqwest::RequestBuilder) -> Result<serde_json::Value, String> {
        let res = req.send().await.map_err(|e| format!("cloudflare: {e}"))?;
        let status = res.status();
        let body: serde_json::Value = res.json().await.map_err(|e| format!("cloudflare: {e}"))?;
        if !status.is_success() || body["success"] != true {
            return Err(format!("cloudflare {status}: {}", body["errors"]));
        }
        Ok(body)
    }

    async fn ensure_cname(&self, name: &str) -> Result<(), String> {
        let found = self.cf_json(self.cf(reqwest::Method::GET, &format!("?type=CNAME&name={name}"))).await?;
        if found["result"].as_array().is_some_and(|r| !r.is_empty()) {
            return Ok(());
        }
        // Never proxied: Cloudflare's proxy would end the TLS that must end
        // in the server.
        let body = serde_json::json!({ "type": "CNAME", "name": name, "content": self.visitor_target, "proxied": false, "ttl": 300 });
        self.cf_json(self.cf(reqwest::Method::POST, "").json(&body)).await?;
        log!("dns.cname", name = name, target = self.visitor_target);
        Ok(())
    }

    async fn create_txt(&self, name: &str, value: &str) -> Result<String, String> {
        let body = serde_json::json!({ "type": "TXT", "name": name, "content": value, "ttl": 60 });
        let made = self.cf_json(self.cf(reqwest::Method::POST, "").json(&body)).await?;
        made["result"]["id"].as_str().map(str::to_string).ok_or_else(|| "cloudflare gave no record id".into())
    }

    async fn delete_record(&self, id: &str) {
        if let Err(e) = self.cf_json(self.cf(reqwest::Method::DELETE, &format!("/{id}"))).await {
            log!("dns.cleanup_failed", record = id, reason = e);
        }
    }

    /// Until 1.1.1.1 answers the record, up to 60s: Let's Encrypt asking
    /// before it is out fails the whole order.
    async fn await_txt(&self, name: &str, value: &str) {
        let Some(doh) = &self.doh else { return };
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline {
            let url = format!("{doh}?name={name}&type=TXT");
            if let Ok(res) = self.http.get(url).header("accept", "application/dns-json").send().await {
                if res.text().await.is_ok_and(|t| t.contains(value)) {
                    return;
                }
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn csr_for(names: &[&str]) -> (String, KeyPair) {
        let key = KeyPair::generate().unwrap();
        let params = CertificateParams::new(names.iter().map(|s| s.to_string()).collect::<Vec<_>>()).unwrap();
        (params.serialize_request(&key).unwrap().pem().unwrap(), key)
    }

    #[test]
    fn a_csr_must_name_its_own_wildcard_alone() {
        let host = "abc.relay.localhost";
        assert!(check_csr(host, &csr_for(&["*.abc.relay.localhost"]).0).is_ok());
        assert!(check_csr(host, &csr_for(&["*.xyz.relay.localhost"]).0).is_err(), "another server's name");
        assert!(check_csr(host, &csr_for(&["*.abc.relay.localhost", "drayhq.com"]).0).is_err(), "a name besides");
        assert!(check_csr(host, "not a csr").is_err());
    }

    #[test]
    fn the_dev_ca_signs_what_it_is_asked() {
        let dir = std::env::temp_dir().join(format!("relay-ca-{}", std::process::id()));
        let dev = Dev::open(dir.clone(), 90).unwrap();
        let (pem, _key) = csr_for(&["*.abc.relay.localhost"]);
        let chain = dev.sign(&check_csr("abc.relay.localhost", &pem).unwrap().0).unwrap();
        let (_, der) = x509_parser::pem::parse_x509_pem(chain.as_bytes()).unwrap();
        let cert = der.parse_x509().unwrap();
        assert!(cert.issuer().to_string().contains("Dray relay dev CA"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn limits_hold_one_at_a_time_and_a_daily_cap() {
        let issuing = Issuing::new(Issuer::None);
        assert!(issuing.admit("a").is_ok());
        assert!(issuing.admit("a").is_err(), "one in flight");
        assert!(issuing.admit("b").is_ok(), "another server is not held up");
        for _ in 0..PER_SERVER_PER_DAY {
            issuing.limits.lock().unwrap().in_flight.clear();
            let _ = issuing.admit("c");
        }
        issuing.limits.lock().unwrap().in_flight.clear();
        assert!(issuing.admit("c").is_err(), "five a day");
    }
}
