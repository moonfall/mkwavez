// A tiny test harness (no dependencies): TEST(name) { CHECK(...); }.
#pragma once

#include <cmath>
#include <cstdio>
#include <functional>
#include <string>
#include <vector>

namespace check {

struct Test {
    const char* name;
    std::function<void()> fn;
};

inline std::vector<Test>& registry() {
    static std::vector<Test> r;
    return r;
}
inline int& failures() {
    static int f = 0;
    return f;
}
inline const char*& current() {
    static const char* c = "";
    return c;
}

struct Registrar {
    Registrar(const char* name, std::function<void()> fn) { registry().push_back({name, std::move(fn)}); }
};

inline bool report(bool ok, const char* expr, const char* file, int line, const std::string& detail = {}) {
    if (!ok) {
        ++failures();
        std::fprintf(stderr, "FAIL [%s] %s:%d: %s %s\n", current(), file, line, expr, detail.c_str());
    }
    return ok;
}

inline bool near(double a, double b, double tol) { return std::abs(a - b) <= tol || (std::isnan(a) && std::isnan(b)); }

} // namespace check

#define CHECK_CAT2(a, b) a##b
#define CHECK_CAT(a, b) CHECK_CAT2(a, b)
#define TEST(name)                                                                       \
    static void CHECK_CAT(test_fn_, __LINE__)();                                         \
    static check::Registrar CHECK_CAT(test_reg_, __LINE__)(name, CHECK_CAT(test_fn_, __LINE__)); \
    static void CHECK_CAT(test_fn_, __LINE__)()
#define CHECK(expr) check::report((expr), #expr, __FILE__, __LINE__)
#define CHECK_NEAR(a, b, tol)                                                                              \
    check::report(check::near((a), (b), (tol)), #a " ≈ " #b, __FILE__, __LINE__,                           \
                  "(" + std::to_string((double) (a)) + " vs " + std::to_string((double) (b)) + ")")
