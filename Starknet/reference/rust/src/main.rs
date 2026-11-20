// Referência independente (Rust, starknet-rs) para os vetores da PoC Starknet da VKX.
// Uso:
//   stark-ref key <class_hash> <priv_hex>...        -> priv;pub;address
//   stark-ref verify <pub> <msg_hash> <r> <s>       -> true/false
use starknet_core::types::Felt;
use starknet_core::utils::get_contract_address;
use starknet_crypto::{get_public_key, verify};

fn f(s: &str) -> Felt { Felt::from_hex(s).expect("hex inválido") }

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("key") => {
            let class_hash = f(&args[2]);
            for k in &args[3..] {
                let pk = get_public_key(&f(k));
                let addr = get_contract_address(pk, class_hash, &[pk], Felt::ZERO);
                println!("{:#066x};{:#066x};{:#066x}", f(k), pk, addr);
            }
        }
        Some("verify") => {
            let ok = verify(&f(&args[2]), &f(&args[3]), &f(&args[4]), &f(&args[5])).unwrap_or(false);
            println!("{}", ok);
        }
        _ => eprintln!("uso: key|verify"),
    }
}
