import { request as httpsRequest, type RequestOptions } from "node:https";
import type { ConnectionOptions } from "node:tls";

import { describe, expect, it } from "vitest";

import { GrpcServer } from "../src/grpc/server.js";
import { DISCOVERY_PATH, serveDiscovery, type DiscoveryDocument } from "../src/identity/discovery.js";
import { ensureCertificates } from "../src/tls/authority.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-discovery-");

const DOCUMENT: DiscoveryDocument = {
    protocol: 1,
    name: "team.example.lan",
    auth: { required: true, url: "https://team.example.lan:41402" },
    data: { url: "lore://team.example.lan:41337" },
    authority: { sha256: "3D:38:9F:E6" },
    version: "0.1.0",
};

/**
 * Fetch over TLS without checking the certificate.
 *
 * This is about the protocol, not about trust: the endpoint presents a certificate from
 * an authority created seconds ago in a temporary directory, and checking it would test
 * the fixture. What the certificate is worth is `certificates.test.ts`.
 */
function fetchOverTls(port: number, path: string): Promise<{ status: number; body: string; alpn: string }> {
    // Typed as both halves on purpose: `https.request` hands its options to
    // `tls.connect`, so `ALPNProtocols` is honoured, but @types/node describes
    // https.RequestOptions without it and rejects it as an unknown property.
    const options: RequestOptions & ConnectionOptions = {
        host: "127.0.0.1",
        port,
        path,
        rejectUnauthorized: false,
        ALPNProtocols: ["http/1.1"],
    };
    return new Promise((resolve, reject) => {
        const call = httpsRequest(
            options,
            (response) => {
                // Read while the socket is still attached: by `end` it is detached and null.
                const alpn = (response.socket as { alpnProtocol?: string } | null)?.alpnProtocol ?? "";
                let body = "";
                response.setEncoding("utf-8");
                response.on("data", (chunk: string) => { body += chunk; });
                response.on("end", () => resolve({
                    status: response.statusCode ?? 0,
                    body,
                    alpn,
                }));
            },
        );
        call.on("error", reject);
        call.end();
    });
}

async function endpoint(): Promise<{ port: number; stop: () => Promise<void> }> {
    const certificates = await ensureCertificates(await temporaryRoot(), { hostnames: [] });
    const server = await GrpcServer.start({
        port: 0,
        methods: {},
        tls: { cert: certificates.leafCertPem, key: certificates.leafKeyPem },
        http1: (incoming, response) => serveDiscovery(DOCUMENT, incoming, response),
    });
    return { port: server.port, stop: () => server.close() };
}

describe("the address an author is given", () => {
    it("answers the discovery document over HTTP/1.1 on the endpoint gRPC uses", { timeout: 30_000 }, async () => {
        // The whole point of one address: this is the same listener, the same port and the
        // same certificate the tokens are presented to. A second endpoint would be a second
        // certificate, and therefore a second thing to trust.
        const { port, stop } = await endpoint();
        try {
            const answer = await fetchOverTls(port, DISCOVERY_PATH);
            expect(answer.alpn).toBe("http/1.1");
            expect(answer.status).toBe(200);
            expect(JSON.parse(answer.body)).toEqual(DOCUMENT);
        } finally {
            await stop();
        }
    });

    it("answers nothing else, because this is not a web interface", { timeout: 30_000 }, async () => {
        const { port, stop } = await endpoint();
        try {
            expect((await fetchOverTls(port, "/")).status).toBe(404);
            expect((await fetchOverTls(port, "/.well-known/jwks.json")).status).toBe(404);
        } finally {
            await stop();
        }
    });
});
