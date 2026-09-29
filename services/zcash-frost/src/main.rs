//! corridor-frost: threshold control of Corridor's Zcash Ironwood treasury.
//!
//! No single person (and not Corridor alone) can move shielded funds. The
//! treasury's spend-authorizing key only exists as FROST shares (RedPallas,
//! the ciphersuite Zcash spend authorization uses); any 2 of 3 signers can
//! authorize a batch.
//!
//! Flow (see docs/ARCHITECTURE.md §6.6):
//!   1. `keygen`  → 3 key shares + the vault's UFVK and address. The group
//!                  verifying key *is* the Orchard/Ironwood `ak`.
//!   2. zcash-devtool imports the UFVK (view-only), builds the batch as a
//!      PCZT and adds proofs.
//!   3. `sign`    → two signers co-sign every Ironwood spend. Each signature
//!                  is rerandomized by that action's `alpha`, so it verifies
//!                  under the action's `rk = ak + [alpha]G`.
//!   4. zcash-devtool combines proofs + signatures and broadcasts.
//!
//! Hackathon scope: `keygen` uses a trusted dealer and `sign` runs both FROST
//! rounds in one process over the selected signers' share files. Production
//! replaces these with DKG and per-device signers relaying through `frostd`;
//! the cryptography and the PCZT interface stay the same.

use std::{collections::BTreeMap, fs, path::PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use clap::{Parser, Subcommand};
use ff::{Field, PrimeField};
use orchard::primitives::redpallas;
use pasta_curves::pallas;
use rand::rngs::OsRng;
use reddsa::frost::redpallas as frost;
use serde::{Deserialize, Serialize};
use zcash_keys::keys::{UnifiedAddressRequest, UnifiedFullViewingKey};
use zcash_protocol::consensus::Network;

#[derive(Parser)]
#[command(name = "corridor-frost", about = "FROST threshold signing for Corridor's Zcash Ironwood treasury")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Create threshold key shares and the treasury's viewing key and address.
    Keygen {
        #[arg(long, default_value_t = 2)]
        threshold: u16,
        #[arg(long, default_value_t = 3)]
        signers: u16,
        /// "test" or "main"
        #[arg(long, default_value = "test")]
        network: String,
        /// Directory to write public.json and signer-<n>.json into.
        #[arg(long)]
        out: PathBuf,
    },
    /// Co-sign every unsigned Ironwood spend in a PCZT that belongs to this treasury.
    Sign {
        #[arg(long)]
        pczt: PathBuf,
        /// Directory produced by `keygen`.
        #[arg(long)]
        keys: PathBuf,
        /// Which signers take part, e.g. `1,3`. Must meet the threshold.
        #[arg(long, value_delimiter = ',')]
        signers: Vec<u16>,
        #[arg(long)]
        out: PathBuf,
    },
    /// Show the Ironwood actions in a PCZT and whether each is signed.
    Inspect {
        #[arg(long)]
        pczt: PathBuf,
    },
}

#[derive(Serialize, Deserialize)]
struct PublicInfo {
    threshold: u16,
    signers: u16,
    network: String,
    /// FROST group verifying key = Orchard/Ironwood spend validating key `ak`.
    group_key: String,
    ufvk: String,
    address: String,
    public_key_package: String,
}

#[derive(Serialize, Deserialize)]
struct SignerShare {
    signer: u16,
    identifier: String,
    key_package: String,
}

fn network(name: &str) -> Result<Network> {
    match name {
        "test" => Ok(Network::TestNetwork),
        "main" => Ok(Network::MainNetwork),
        other => bail!("unknown network {other}"),
    }
}

fn keygen(threshold: u16, signers: u16, net: &str, out: PathBuf) -> Result<()> {
    if threshold < 2 || threshold > signers {
        bail!("need 2 <= threshold <= signers");
    }
    let params = network(net)?;

    // Orchard requires ak to encode with a positive y-coordinate (sign bit clear).
    // Half of all group keys qualify, so draw until one does.
    let (shares, pubkeys, ak) = loop {
        let (shares, pubkeys) =
            frost::keys::generate_with_dealer(signers, threshold, frost::keys::IdentifierList::Default, OsRng)?;
        let ak: [u8; 32] = pubkeys
            .verifying_key()
            .serialize()?
            .try_into()
            .map_err(|_| anyhow!("group key is not 32 bytes"))?;
        if ak[31] & 0x80 == 0 {
            break (shares, pubkeys, ak);
        }
    };

    // nk and rivk are ordinary random values held by Corridor's viewing side;
    // only ak (spend authority) is threshold-controlled.
    let fvk = loop {
        let mut raw = [0u8; 96];
        raw[..32].copy_from_slice(&ak);
        raw[32..64].copy_from_slice(&pallas::Base::random(OsRng).to_repr());
        raw[64..].copy_from_slice(&pallas::Scalar::random(OsRng).to_repr());
        if let Some(fvk) = orchard::keys::FullViewingKey::from_bytes(&raw) {
            break fvk;
        }
    };
    let ufvk = UnifiedFullViewingKey::from_orchard_fvk(fvk).map_err(|e| anyhow!("ufvk: {e:?}"))?;
    let (ua, _) = ufvk
        .default_address(UnifiedAddressRequest::SHIELDED)
        .map_err(|e| anyhow!("address: {e:?}"))?;

    fs::create_dir_all(&out)?;
    let info = PublicInfo {
        threshold,
        signers,
        network: net.into(),
        group_key: hex::encode(ak),
        ufvk: ufvk.encode(&params),
        address: ua.encode(&params),
        public_key_package: hex::encode(pubkeys.serialize()?),
    };
    fs::write(out.join("public.json"), serde_json::to_string_pretty(&info)?)?;

    for (n, (id, share)) in shares.into_iter().enumerate() {
        let kp = frost::keys::KeyPackage::try_from(share)?;
        let s = SignerShare {
            signer: n as u16 + 1,
            identifier: hex::encode(id.serialize()),
            key_package: hex::encode(kp.serialize()?),
        };
        let path = out.join(format!("signer-{}.json", n + 1));
        fs::write(&path, serde_json::to_string_pretty(&s)?)?;
        restrict(&path)?;
    }

    println!("{}", serde_json::to_string(&serde_json::json!({
        "threshold": threshold, "signers": signers,
        "ufvk": info.ufvk, "address": info.address, "group_key": info.group_key,
    }))?);
    Ok(())
}

#[cfg(unix)]
fn restrict(path: &PathBuf) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}
#[cfg(not(unix))]
fn restrict(_: &PathBuf) -> Result<()> {
    Ok(())
}

struct Target {
    index: usize,
    alpha: pallas::Scalar,
    rk: [u8; 32],
}

/// Unsigned Ironwood spends in the PCZT, with the randomizer each must be signed under.
fn ironwood_targets(pczt: pczt::Pczt) -> Result<(pczt::Pczt, Vec<Target>, usize)> {
    let mut targets = Vec::new();
    let mut total = 0;
    let pczt = pczt::roles::verifier::Verifier::new(pczt)
        .with_ironwood(|bundle| {
            total = bundle.actions().len();
            for (index, action) in bundle.actions().iter().enumerate() {
                let spend = action.spend();
                if spend.spend_auth_sig().is_some() {
                    continue;
                }
                if let Some(alpha) = spend.alpha() {
                    targets.push(Target { index, alpha: *alpha, rk: <[u8; 32]>::from(spend.rk()) });
                }
            }
            Ok::<_, pczt::roles::verifier::OrchardError<std::convert::Infallible>>(())
        })
        .map_err(|e| anyhow!("reading Ironwood bundle: {e:?}"))?
        .finish();
    Ok((pczt, targets, total))
}

fn load_pczt(path: &PathBuf) -> Result<pczt::Pczt> {
    let bytes = fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    pczt::Pczt::parse(&bytes).map_err(|e| anyhow!("parsing PCZT: {e:?}"))
}

fn sign(pczt_path: PathBuf, keys: PathBuf, signer_ids: Vec<u16>, out: PathBuf) -> Result<()> {
    let info: PublicInfo = serde_json::from_slice(&fs::read(keys.join("public.json"))?)?;
    let pubkeys = frost::keys::PublicKeyPackage::deserialize(&hex::decode(&info.public_key_package)?)?;

    let mut participants: BTreeMap<frost::Identifier, frost::keys::KeyPackage> = BTreeMap::new();
    for n in &signer_ids {
        let s: SignerShare = serde_json::from_slice(&fs::read(keys.join(format!("signer-{n}.json")))?)
            .with_context(|| format!("loading signer {n}"))?;
        let kp = frost::keys::KeyPackage::deserialize(&hex::decode(&s.key_package)?)?;
        participants.insert(*kp.identifier(), kp);
    }
    if participants.len() < info.threshold as usize {
        bail!("{} signers given, threshold is {}", participants.len(), info.threshold);
    }

    let (pczt, targets, total) = ironwood_targets(load_pczt(&pczt_path)?)?;
    let mut signer = pczt::roles::signer::Signer::new(pczt).map_err(|e| anyhow!("signer: {e:?}"))?;
    let sighash = signer.shielded_sighash();

    let mut signed = 0;
    for t in targets {
        let randomizer = frost::rerandomized::Randomizer::from_scalar(t.alpha);
        let params = frost::rerandomized::RandomizedParams::from_randomizer(pubkeys.verifying_key(), randomizer);
        // Only spends of this treasury: the action's rk must be our group key rerandomized by alpha.
        if params.randomized_verifying_key().serialize()? != t.rk {
            eprintln!("action {}: not a spend of this treasury, skipped", t.index);
            continue;
        }

        // Round 1: each participating signer commits to fresh nonces.
        let mut nonces = BTreeMap::new();
        let mut commitments = BTreeMap::new();
        for (id, kp) in &participants {
            let (n, c) = frost::round1::commit(kp.signing_share(), &mut OsRng);
            nonces.insert(*id, n);
            commitments.insert(*id, c);
        }
        let package = frost::SigningPackage::new(commitments, &sighash);

        // Round 2: each signer produces a share under the action's randomizer.
        let mut shares = BTreeMap::new();
        for (id, kp) in &participants {
            #[allow(deprecated)] // Zcash dictates the randomizer (alpha), so the explicit-randomizer API is the right one.
            let share = frost_rerandomized::sign(&package, &nonces[id], kp, randomizer)?;
            shares.insert(*id, share);
        }

        // Aggregate into one RedPallas SpendAuth signature and check it before applying.
        let sig = frost::rerandomized::aggregate(&package, &shares, &pubkeys, &params)?;
        let sig_bytes: [u8; 64] = sig.serialize()?.try_into().map_err(|_| anyhow!("signature is not 64 bytes"))?;
        let rsig = redpallas::Signature::<redpallas::SpendAuth>::from(sig_bytes);
        redpallas::VerificationKey::<redpallas::SpendAuth>::try_from(t.rk)
            .map_err(|e| anyhow!("rk: {e:?}"))?
            .verify(&sighash, &rsig)
            .map_err(|e| anyhow!("aggregated signature does not verify under rk: {e:?}"))?;

        signer
            .apply_ironwood_signature(t.index, rsig)
            .map_err(|e| anyhow!("applying signature to action {}: {e:?}", t.index))?;
        signed += 1;
    }

    let pczt = signer.finish();
    fs::write(&out, pczt.serialize().map_err(|e| anyhow!("serializing PCZT: {e:?}"))?)?;
    println!("{}", serde_json::to_string(&serde_json::json!({
        "ironwood_actions": total, "signed": signed,
        "signers": signer_ids, "threshold": info.threshold,
        "sighash": hex::encode(sighash), "out": out,
    }))?);
    if signed == 0 {
        bail!("no Ironwood spends of this treasury found to sign");
    }
    Ok(())
}

fn inspect(path: PathBuf) -> Result<()> {
    let pczt = load_pczt(&path)?;
    let mut rows = Vec::new();
    pczt::roles::verifier::Verifier::new(pczt)
        .with_ironwood(|bundle| {
            for (i, a) in bundle.actions().iter().enumerate() {
                rows.push(serde_json::json!({
                    "action": i,
                    "signed": a.spend().spend_auth_sig().is_some(),
                    "has_alpha": a.spend().alpha().is_some(),
                    "spend_value": a.spend().value().map(|v| v.inner()),
                    "output_value": a.output().value().map(|v| v.inner()),
                }));
            }
            Ok::<_, pczt::roles::verifier::OrchardError<std::convert::Infallible>>(())
        })
        .map_err(|e| anyhow!("reading Ironwood bundle: {e:?}"))?;
    println!("{}", serde_json::to_string_pretty(&rows)?);
    Ok(())
}

fn main() -> Result<()> {
    match Cli::parse().cmd {
        Cmd::Keygen { threshold, signers, network, out } => keygen(threshold, signers, &network, out),
        Cmd::Sign { pczt, keys, signers, out } => sign(pczt, keys, signers, out),
        Cmd::Inspect { pczt } => inspect(pczt),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dealer() -> (BTreeMap<frost::Identifier, frost::keys::KeyPackage>, frost::keys::PublicKeyPackage) {
        let (shares, pubkeys) =
            frost::keys::generate_with_dealer(3, 2, frost::keys::IdentifierList::Default, OsRng).unwrap();
        let kps = shares
            .into_iter()
            .map(|(id, s)| (id, frost::keys::KeyPackage::try_from(s).unwrap()))
            .collect();
        (kps, pubkeys)
    }

    /// Two-round FROST over the given signers, rerandomized by `alpha`.
    fn threshold_sign(
        signers: &[&frost::keys::KeyPackage],
        pubkeys: &frost::keys::PublicKeyPackage,
        alpha: pallas::Scalar,
        msg: &[u8],
    ) -> Result<(redpallas::Signature<redpallas::SpendAuth>, [u8; 32])> {
        let randomizer = frost::rerandomized::Randomizer::from_scalar(alpha);
        let params = frost::rerandomized::RandomizedParams::from_randomizer(pubkeys.verifying_key(), randomizer);
        let mut nonces = BTreeMap::new();
        let mut commitments = BTreeMap::new();
        for kp in signers {
            let (n, c) = frost::round1::commit(kp.signing_share(), &mut OsRng);
            nonces.insert(*kp.identifier(), n);
            commitments.insert(*kp.identifier(), c);
        }
        let package = frost::SigningPackage::new(commitments, msg);
        let mut shares = BTreeMap::new();
        for kp in signers {
            #[allow(deprecated)]
            let share = frost_rerandomized::sign(&package, &nonces[kp.identifier()], kp, randomizer)?;
            shares.insert(*kp.identifier(), share);
        }
        let sig = frost::rerandomized::aggregate(&package, &shares, pubkeys, &params)?;
        let bytes: [u8; 64] = sig.serialize()?.try_into().unwrap();
        let rk: [u8; 32] = params.randomized_verifying_key().serialize()?.try_into().unwrap();
        Ok((redpallas::Signature::from(bytes), rk))
    }

    #[test]
    fn two_of_three_produces_a_valid_rerandomized_spend_auth_signature() {
        let (kps, pubkeys) = dealer();
        let signers: Vec<_> = kps.values().take(2).collect();
        let alpha = pallas::Scalar::random(OsRng);
        let sighash = [7u8; 32];
        let (sig, rk) = threshold_sign(&signers, &pubkeys, alpha, &sighash).unwrap();
        // Verifies under rk = ak + [alpha]G exactly as Zcash consensus checks a spend.
        redpallas::VerificationKey::<redpallas::SpendAuth>::try_from(rk)
            .unwrap()
            .verify(&sighash, &sig)
            .unwrap();
        // ...and not under a different message.
        assert!(redpallas::VerificationKey::<redpallas::SpendAuth>::try_from(rk)
            .unwrap()
            .verify(&[8u8; 32], &sig)
            .is_err());
    }

    #[test]
    fn any_two_signers_work_but_one_does_not() {
        let (kps, pubkeys) = dealer();
        let all: Vec<_> = kps.values().collect();
        for pair in [[0, 1], [0, 2], [1, 2]] {
            let signers = [all[pair[0]], all[pair[1]]];
            assert!(threshold_sign(&signers, &pubkeys, pallas::Scalar::random(OsRng), b"batch").is_ok());
        }
        assert!(threshold_sign(&[all[0]], &pubkeys, pallas::Scalar::random(OsRng), b"batch").is_err());
    }

    #[test]
    fn keygen_writes_a_valid_ironwood_viewing_key_and_address() {
        let dir = std::env::temp_dir().join(format!("corridor-frost-test-{}", std::process::id()));
        keygen(2, 3, "test", dir.clone()).unwrap();
        let info: PublicInfo = serde_json::from_slice(&fs::read(dir.join("public.json")).unwrap()).unwrap();
        assert!(info.ufvk.starts_with("uviewtest1"));
        assert!(info.address.starts_with("utest1"));
        // The group key is the vault's ak, with the sign bit Orchard requires.
        assert_eq!(hex::decode(&info.group_key).unwrap()[31] & 0x80, 0);
        assert!(UnifiedFullViewingKey::decode(&Network::TestNetwork, &info.ufvk).is_ok());
        fs::remove_dir_all(dir).ok();
    }
}
