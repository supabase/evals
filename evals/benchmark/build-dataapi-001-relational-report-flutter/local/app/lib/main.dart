import 'package:flutter/material.dart';

import 'sales_report.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await connect(
    url: const String.fromEnvironment('SUPABASE_URL'),
    publishableKey: const String.fromEnvironment('SUPABASE_PUBLISHABLE_KEY'),
  );
  runApp(const SalesDashboardApp());
}

class SalesDashboardApp extends StatefulWidget {
  const SalesDashboardApp({super.key});

  @override
  State<SalesDashboardApp> createState() => _SalesDashboardAppState();
}

class _SalesDashboardAppState extends State<SalesDashboardApp> {
  var _signedIn = false;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Sales dashboard',
      home: _signedIn
          ? const ReportPage()
          : SignInPage(onSignedIn: () => setState(() => _signedIn = true)),
    );
  }
}

class SignInPage extends StatefulWidget {
  const SignInPage({super.key, required this.onSignedIn});

  final VoidCallback onSignedIn;

  @override
  State<SignInPage> createState() => _SignInPageState();
}

class _SignInPageState extends State<SignInPage> {
  final _email = TextEditingController();
  final _password = TextEditingController();
  String? _error;

  Future<void> _submit() async {
    try {
      await signIn(email: _email.text, password: _password.text);
      widget.onSignedIn();
    } catch (error) {
      setState(() => _error = '$error');
    }
  }

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Staff sign-in')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            TextField(
              controller: _email,
              decoration: const InputDecoration(labelText: 'Email'),
            ),
            TextField(
              controller: _password,
              obscureText: true,
              decoration: const InputDecoration(labelText: 'Password'),
            ),
            const SizedBox(height: 16),
            FilledButton(onPressed: _submit, child: const Text('Sign in')),
            if (_error != null) Text(_error!),
          ],
        ),
      ),
    );
  }
}

class ReportPage extends StatelessWidget {
  const ReportPage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Sales report')),
      body: FutureBuilder(
        future: loadSalesReport(),
        builder: (context, snapshot) {
          if (snapshot.hasError) {
            return Center(child: Text('${snapshot.error}'));
          }
          final rows = snapshot.data;
          if (rows == null) {
            return const Center(child: CircularProgressIndicator());
          }
          return ListView(
            children: [
              for (final row in rows)
                ListTile(
                  title: Text('${row['customer']}'),
                  subtitle: Text(
                    '${row['orderCount']} orders, top product ${row['topProduct']}',
                  ),
                  trailing: Text('${row['totalCents']} cents'),
                ),
            ],
          );
        },
      ),
    );
  }
}
