import XCTest

extension XCUIApplication {
    /// The session dock's reply by keyboard: open the sheet, type, back to the dock, Send.
    func reply(_ text: String) {
        buttons["Keyboard"].tap()
        let editor = textViews.firstMatch
        XCTAssertTrue(editor.waitForExistence(timeout: 5), "the keyboard opened no sheet")
        editor.typeText(text)
        buttons["Done"].tap()
        buttons["Send"].tap()
    }

    /// The session dock, drawn once the session is open.
    var dock: XCUIElement { buttons["Keyboard"] }
}
