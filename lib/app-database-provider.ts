// Tests and historical tools may use an explicit SQLite client in the same
// process as the PostgreSQL app client.
const postgresClients = new WeakSet<object>();
export const registerAppPostgres = (client: object) => postgresClients.add(client);
export const usesAppPostgres = (client: object) => postgresClients.has(client);
