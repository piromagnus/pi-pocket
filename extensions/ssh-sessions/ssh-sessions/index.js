export const pocketApi = 1;

export default function setup(pocket) {
    const { html, useEffect, useState, Loader } = pocket;

    pocket.style("style.css");

    function SshSessions({ close }) {
        const [hosts, setHosts] = useState(null);
        const [host, setHost] = useState("");
        const [path, setPath] = useState("~");
        const [busy, setBusy] = useState(false);
        const [error, setError] = useState(null);
        const [key, setKey] = useState(null);
        const [confirmed, setConfirmed] = useState(false);

        useEffect(() => {
            const stop = new AbortController();

            pocket.api("hosts", undefined, { signal: stop.signal }).then(
                ({ hosts: found }) => {
                    setHosts(found);
                    setHost(found.includes("hextech") ? "hextech" : found[0] || "");
                },
                (failure) => {
                    if (!stop.signal.aborted) {
                        setError(failure.message);
                        setHosts([]);
                    }
                },
            );

            return () => stop.abort();
        }, []);

        const run = async (action) => {
            if (busy) {
                return;
            }

            setBusy(true);
            setError(null);

            try {
                await action();
            } catch (failure) {
                setError(failure.message || "La connexion SSH a échoué.");
            } finally {
                setBusy(false);
            }
        };

        const scan = () =>
            run(async () => {
                setConfirmed(false);
                setKey(null);
                setKey(await pocket.api("scan", { host }));
            });
        const trust = () =>
            run(async () => {
                await pocket.api("trust", { host, lines: key.lines, confirmed });
                setKey(null);
                setConfirmed(false);
            });

        const create = (event) => {
            event.preventDefault();
            void run(async () => {
                const { id } = await pocket.api("sessions", { host, path });

                close();
                pocket.openConversation(id);
            });
        };

        if (hosts === null) {
            return html`<${Loader} label="Lecture de ~/.ssh/config" />`;
        }

        return html`<div class="ssh-sessions">
            ${error && html`<div class="error-box" role="alert">${error}</div>`}
            ${
                !hosts.length
                    ? html`<p>Aucun alias Host disponible dans ~/.ssh/config.</p>`
                    : html`<form onSubmit=${create}>
                          <label for="ssh-host">Hôte SSH</label>
                          <select
                              id="ssh-host"
                              value=${host}
                              disabled=${busy}
                              onChange=${(event) => {
                                  setHost(event.target.value);
                                  setKey(null);
                                  setConfirmed(false);
                                  setError(null);
                              }}
                          >
                              ${hosts.map((alias) => html`<option value=${alias}>${alias}</option>`)}
                          </select>
                          <label for="ssh-path">Dossier distant</label>
                          <input
                              id="ssh-path"
                              value=${path}
                              placeholder="/home/pierre"
                              spellcheck="false"
                              autocapitalize="off"
                              autocomplete="off"
                              required
                              disabled=${busy}
                              onInput=${(event) => setPath(event.target.value)}
                          />
                          <button
                              class="button primary"
                              type="submit"
                              disabled=${busy || !host || !path}
                          >
                              ${busy ? "Connexion…" : "Créer la session distante"}
                          </button>
                          <button class="button" type="button" disabled=${busy} onClick=${scan}>
                              Vérifier la clé SSH
                          </button>
                      </form>`
            }
            ${
                key &&
                html`<section class="ssh-host-key" aria-label="Vérification de l’hôte SSH">
                    <h3>Clé de ${host}</h3>
                    <pre class="mono">${key.fingerprints.join("\n")}</pre>
                    <label class="ssh-confirm">
                        <input
                            type="checkbox"
                            checked=${confirmed}
                            disabled=${busy}
                            onChange=${(event) => setConfirmed(event.target.checked)}
                        />
                        <span>J’ai comparé cette empreinte avec celle de la machine.</span>
                    </label>
                    <button class="button" disabled=${busy || !confirmed} onClick=${trust}>
                        Faire confiance à cette clé
                    </button>
                </section>`
            }
        </div>`;
    }

    pocket.page({ id: "ssh", title: "Session distante SSH", component: SshSessions });
    pocket.rail({ id: "ssh", title: "SSH", icon: "globe", page: "ssh" });
    pocket.launcher({ id: "ssh", label: "Créer une session SSH", icon: "globe", page: "ssh" });
    pocket.menu({ id: "ssh", label: "Session distante SSH", page: "ssh" });

    if (typeof pocket.sessionChips === "function") {
        pocket.sessionChips({
            id: "ssh",
            chips: (session) => {
                const match = /^ssh:\/\/([^/]+)\//.exec(session.cwd);

                return match ? [{ label: `SSH · ${match[1]}`, title: session.cwd }] : [];
            },
        });
    }
}
