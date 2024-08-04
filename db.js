const database = "db.json";
const fs = require("fs");
const path = require("path");

module.exports = {
    /**
     * Get the database
     * @returns {Object}
     * @example
     * const db = require("./db");
     * console.log(db.get());
     * // { users: [] }
     * @example
     * const db = require("./db");
     * console.log(db.get().users);
     * // []
     * @example
     * const db = require("./db");
     * console.log(db.get().users[0]);
     * // undefined
     */
    get: function() {
        return JSON.parse(fs.readFileSync(database, "utf8"));
    },
    /**
     * Set the database
     * @param {Object} data The data to set
     * @example
     * const db = require("./db");
     * db.set({ users: [{ id: 1, username: "example" }] });
     */
    set: function(data) {
        fs.writeFileSync(database, JSON.stringify(data, null, 2));
    }
}    