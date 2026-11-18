import Foundation
import Security

/// Secrets kept on the device: a pasted bearer token, or an indiko grant as JSON.
enum Keychain {
    enum Account: String {
        case bearer
        case oauth
    }

    private static func query(_ account: Account) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "sh.dunkirk.cedarengine",
            kSecAttrAccount as String: account.rawValue,
        ]
    }

    static func read(_ account: Account = .bearer) -> Data? {
        var lookup = query(account)
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(lookup as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    static func save(_ data: Data, as account: Account = .bearer) {
        delete(account)
        var item = query(account)
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }

    static func delete(_ account: Account) {
        SecItemDelete(query(account) as CFDictionary)
    }

    static func deleteAll() {
        delete(.bearer)
        delete(.oauth)
    }
}
