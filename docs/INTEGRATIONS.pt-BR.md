# VKX Wallet — Visão técnica das integrações multirrede

Autocustódia, execução patrocinada e acesso por moeda fiduciária na mesma carteira.

Referência técnica para equipes de ecossistemas, parceiros e avaliadores. O documento conecta o núcleo criptográfico público à infraestrutura de produção da wallet, sem publicar o código proprietário do aplicativo.

Retrato verificado em 3 de novembro de 2026. As configurações podem mudar.

## Transações patrocinadas em cinco redes

A configuração de produção habilita paymasters EVM na BNB Smart Chain, Base, Arbitrum One e Polygon PoS, além de um pagador de taxas na Solana. Conferimos os quatro paymasters EVM v0.8 habilitados com eth_chainId e eth_getCode: as redes corresponderam e todos os endereços retornaram bytecode implantado.

- BNB Smart Chain (56): Habilitado, sujeito à elegibilidade. [Paymaster](https://bscscan.com/address/0x39F01976686b906E1c6B0D243cB9dc1a33D21106).
- Ethereum (1): Desabilitado. [Paymaster](https://etherscan.io/address/0xCbAC92a70fb50ab97990774566D50949Ada0bB3d).
- Base (8453): Habilitado, sujeito à elegibilidade. [Paymaster](https://basescan.org/address/0x7Bd2024cAd405ccA960fE9989334A70153c41682).
- Arbitrum One (42161): Habilitado, sujeito à elegibilidade. [Paymaster](https://arbiscan.io/address/0xA6283Ae08849E1B2a10EF0204541c4B0f5C48b5F).
- Polygon PoS (137): Habilitado, sujeito à elegibilidade. [Paymaster](https://polygonscan.com/address/0x6a2dA242B0eEbc17706B9A046c6AA5ef37bDEc01).
- Solana: Pagador de taxas habilitado. [Fee payer](https://solscan.io/account/2C8Kxe2rZhAgfu6zTgiQPrtDHANaJVq8tij7YnPxrMb5).

Gasless indica quem paga a taxa de rede, não ausência de custos. A elegibilidade depende da operação, conta, saldo nativo, limites e recursos do patrocinador. Envios de moeda nativa, chamadas arbitrárias de dApps e qualquer swap não são automaticamente cobertos. Ethereum tem infraestrutura implantada, mas o patrocínio está desabilitado. Não afirmamos patrocínio para Bitcoin, TRON ou Robinhood.

## Como a execução se separa da posse das chaves

- **Aparelho do usuário:** Gera e protege as chaves; assina a operação solicitada.
- **Serviços VKX:** Conferem elegibilidade e constroem a rota suportada. Os fluxos EVM incluem abstração de conta e complementação elegível de gás nativo.
- **Liquidação na rede:** Bundler / EntryPoint e paymaster nas EVM, ou coassinatura na Solana com pagador de taxas definido. A confirmação é reconciliada com a rede.

## Compra e venda: Transak e Pix

A Transak está integrada como parceira de compra com cartão. A wallet consulta cobertura e cotações, prepara o checkout hospedado e oferece entrega direta ou rotas suportadas de swap / ponte. Apple Pay e Google Pay dependem de país, aparelho e elegibilidade do provedor. O acompanhamento usa eventos de webhook e reconciliação. KYC, taxas, ativos e meios de pagamento são definidos para a rota escolhida.

O Pix usa a integração XGate para pagamentos em reais e a orquestração de entrega da VKX. Neste retrato, a API anunciava compras em Polygon, BSC, Ethereum, Base, Robinhood e Solana; vendas também incluíam TRON. Arbitrum não estava na lista anunciada de Pix, portanto não afirmamos compra direta Pix–Arbitrum disponível neste momento. Restrições de token, liquidez e região continuam aplicáveis.

Entregas e funding entre redes usam integrações por rota, incluindo deBridge, LI.FI, Across e CCTP onde suportados. Uma integração não garante disponibilidade de todo par ou rede a qualquer momento.

## Funding na Arbitrum e copy trading

A integração de trading implementada usa USDC nativo na Arbitrum One (chain 42161) como destino de funding. A wallet prepara o aporte, consolida ativos suportados quando necessário e oferece assinaturas de estratégias, novos aportes, retiradas e histórico de posições. A integração se conecta ao provedor de trading e à execução na Hyperliquid; usar Arbitrum no funding não significa que os derivativos sejam executados na Arbitrum.

A configuração de trading e as ações da conta exigem autenticação. Esta publicação descreve a implementação revisada; não publica posições de clientes, retornos, patrimônio sob gestão nem disponibilidade universal de estratégias.

## O que pode ser verificado agora

- Abra os links dos paymasters e confira código e atividade pública no explorador correspondente. Contrato implantado comprova implantação, não adoção nem o resultado de toda transação.
- Baixe o JSON de evidências com data e compare com os endpoints públicos. O retrato é uma observação pontual, não garantia de disponibilidade contínua.
- Revise o núcleo criptográfico com licença MIT: derivação do PIN com scrypt, envelopes AES-256-GCM, geração de chaves e testes de derivação. O repositório público não é o aplicativo completo, o backend de pagamentos ou o roteador.
- Consulte o modelo de segurança e o processo de divulgação responsável. Relatório de auditoria independente e builds reproduzíveis do app completo ainda não foram publicados.

[GitHub](https://github.com/VkxProtocol/VKX-Wallet) · [Evidence JSON](https://wallet.vkxtech.com.br/wallet-integrations-evidence.json) · [Security](https://wallet.vkxtech.com.br/wallet-security)

## Indicadores e exemplos de transações

Não inferimos usuários, volume ou TVL da quantidade de redes, implantação de contratos ou tamanho do catálogo. Nenhum pagamento de cliente foi publicado como exemplo promocional. As referências de infraestrutura acima são públicas; indicadores reconciliados e estudos de transações autorizados podem complementar o documento quando disponíveis.

## Referências de integração

Transak: compra com cartão. XGate: trilho Pix brasileiro. deBridge, LI.FI, Across e CCTP: infraestrutura conforme a rota. Mira / Hyperliquid: integração e execução de trading. Essas descrições identificam funções técnicas; não significam endosso da VKX por todas as organizações citadas.
