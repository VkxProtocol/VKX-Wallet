"""Referência independente (Python, só biblioteca padrão) da derivação Starknet da VKX.

Frase BIP39 -> semente (PBKDF2-HMAC-SHA512, 2048) -> BIP32 secp256k1
m/44'/9004'/0'/0/{i} -> grind_key (StarkWare) -> chave privada Stark ->
chave pública Stark (coordenada x de k*G na curva Stark).

Não usa ethers, starknet.js, @scure ou noble. Uso:
    python -I ref.py "<frase>" 0 1 2
Saída por índice: i;caminho;chave_bip32;chave_stark;pub_stark
"""
import hashlib
import hmac
import sys
import unicodedata

# secp256k1
P1 = 2**256 - 2**32 - 977
N1 = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G1 = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
      0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)

# Curva Stark: y^2 = x^3 + alpha*x + beta (mod p)
P2 = 2**251 + 17 * 2**192 + 1
N2 = 0x0800000000000010FFFFFFFFFFFFFFFFB781126DCAE7B2321E66A241ADC64D2F
A2 = 1
B2 = 0x06F21413EFBE40DE150E596D72F7A8C5609AD26C15C915C1F4CDFCB99CEE9E89
G2 = (0x01EF15C18599971B7BECED415A40F0C7DEACFD9B0D1819E03D723D8BC943CFCA,
      0x005668060AA49730B7BE4801DF46EC62DE53ECD11ABE43A32873000C36E8DC1F)


def ec_add(p, q, mod, a):
    if p is None:
        return q
    if q is None:
        return p
    if p[0] == q[0] and (p[1] + q[1]) % mod == 0:
        return None
    if p == q:
        lam = (3 * p[0] * p[0] + a) * pow(2 * p[1], -1, mod) % mod
    else:
        lam = (q[1] - p[1]) * pow(q[0] - p[0], -1, mod) % mod
    x = (lam * lam - p[0] - q[0]) % mod
    return (x, (lam * (p[0] - x) - p[1]) % mod)


def ec_mul(k, pt, mod, a):
    r = None
    while k:
        if k & 1:
            r = ec_add(r, pt, mod, a)
        pt = ec_add(pt, pt, mod, a)
        k >>= 1
    return r


def ser_pub(k):
    x, y = ec_mul(k, G1, P1, 0)
    return bytes([2 + (y & 1)]) + x.to_bytes(32, "big")


def bip32_path(seed, path):
    I = hmac.new(b"Bitcoin seed", seed, hashlib.sha512).digest()
    k, c = int.from_bytes(I[:32], "big"), I[32:]
    for part in path.split("/")[1:]:
        hard = part.endswith("'")
        idx = int(part.rstrip("'")) + (2**31 if hard else 0)
        data = (b"\x00" + k.to_bytes(32, "big")) if hard else ser_pub(k)
        I = hmac.new(c, data + idx.to_bytes(4, "big"), hashlib.sha512).digest()
        k, c = (int.from_bytes(I[:32], "big") + k) % N1, I[32:]
    return k


def min_be_bytes(i):
    # índice em bytes big-endian mínimos; 0 -> b"\x00"
    return i.to_bytes(max(1, (i.bit_length() + 7) // 8), "big")


def grind_key(seed_int):
    limit = 2**256 - (2**256 % N2)
    seed = seed_int.to_bytes(32, "big")
    for i in range(100000):
        h = int.from_bytes(hashlib.sha256(seed + min_be_bytes(i)).digest(), "big")
        if h < limit:
            return h % N2
    raise RuntimeError("grind_key não convergiu")


def main():
    phrase = unicodedata.normalize("NFKD", " ".join(sys.argv[1].split()))
    seed = hashlib.pbkdf2_hmac("sha512", phrase.encode(), b"mnemonic", 2048)
    # sanidade das constantes da curva Stark: G pertence à curva
    gx, gy = G2
    assert (gy * gy - (gx**3 + A2 * gx + B2)) % P2 == 0, "G Stark fora da curva"
    for arg in sys.argv[2:]:
        i = int(arg)
        path = f"m/44'/9004'/0'/0/{i}"
        k1 = bip32_path(seed, path)
        k2 = grind_key(k1)
        pub = ec_mul(k2, G2, P2, A2)[0]
        print(f"{i};{path};{k1:#066x};{k2:#066x};{pub:#066x}")


if __name__ == "__main__":
    main()
