// Existing news rows use this collector ID as their stable storage namespace.
// Trading wallets authenticate app sessions independently of the news account.
export function newsAccountAddress(): string {
    const account = process.env.NEWS_COLLECTOR_OWNER_ADDRESS?.trim().toLowerCase();
    if (!account) throw new Error("News collection is not configured");
    return account;
}
