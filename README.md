config-general
==============

A port to NodeJS of the Perl module Config::General

This code is currently in Alpha and only as functional as the testing has
pushed me to make it. For the unit-tests to actually function, you have to
enable 'harmony' features - ie: node --harmony.

Please do not attempt to use this code in a production environment at this
time - it is not completely tested and has at least one known bug that is
being worked on at this time.

The code is mostly complete and functional, but I have not completely
converted the unit-tests used to test the Perl module and there are some
known issues with the current code. One of those is dealing with quoted
strings as tag-identifiers and values in key-value pairs. That should be
resolved tomorrow, but at this time I do not have a solid idea of how to
solve the problems surrounding it, as I need to replace the quotes on, at
least, the key-value pairs when writing the file out if the save_value()
method of the system is called.

To run the tests:
make sure tap is installed (ie: npm install tap)
<pre>
run: 
  (if you don't have tap installed globally)
node node_modules/tap/bin/tap.js --harmony t/\*.js
  (if you do have tap installed globally)
tap --harmony t/\*.js
</pre>

The test numbered 33 in t/run.t (the test-suite) of the Perl versions source
is being skipped in its entirety since there is no functional interface at
this time. There will also be no testing of the 'Tie' parameter as that one
would unduly complicate the code of the proxy - a feature that will not
always be available - and likely create some security holes. (the 'Tie' test
is listed in the original test-suite as #48 - we will be skipping it)

Test 49 in the original test-suite (now, partially, in
t/25-test-for-undef.js) also tested for Perl's -w parameter and how things
were handled around that. As I cannot find similar for NodeJS, we cannot
test similar.


