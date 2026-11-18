FROM nginx:1.28.2-alpine
RUN mv /usr/share/nginx/html/index.html /usr/share/nginx/default-index.html
COPY nginx.conf.template /etc/agrotrac/nginx.conf.template
COPY proxy-common.conf proxy-live.conf protected.conf /etc/agrotrac/
COPY entrypoint.sh /usr/local/bin/agrotrac-entrypoint
ENTRYPOINT ["/bin/sh", "/usr/local/bin/agrotrac-entrypoint"]
CMD ["nginx", "-g", "daemon off;"]
